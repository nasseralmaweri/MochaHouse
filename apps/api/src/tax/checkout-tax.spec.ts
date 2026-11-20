import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { ConflictException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  CHECKOUT_TAX_CHANGED,
  CHECKOUT_TAX_NOT_CONFIGURED,
  type CheckoutQuoteResponse,
} from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removePaymentRecoveryRecordsForTest,
  removeTaxSettingsForTest,
  removeTestTenantB,
  tenantContextFor,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisModule } from '../redis/redis.module';
import { LocationsModule } from '../locations/locations.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { CustomersModule } from '../customers/customers.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';
import { PaymentModule } from '../payment/payment.module';
import { CheckoutService } from '../orders/application/checkout.service';
import type { SavedCheckout } from '../orders/application/checkout-snapshot';
import {
  canonicalizeGiftCardCode,
  generateGiftCardCode,
  hashGiftCardCode,
} from '../gift-cards/infrastructure/gift-card-code';
import {
  attemptsOfCheckout,
  checkoutAttemptsOfThisSuite,
  checkoutSessionsOfThisSuite,
  submitCheckout,
  type LabelledCheckoutRequest,
} from '../../test/checkout-session';
import {
  SalesTaxService,
  TaxNotConfiguredError,
} from './application/checkout-tax';
import { BUILT_IN_SALES_TAX_PROVIDER } from './application/sales-tax-provider';

// V1 Sales Tax PR 2 — sales tax at checkout, end to end through the real
// checkout service and a disposable database (the one-step fake payment
// provider). Covers: the switch (off: exactly as before), a location with no
// confirmed settings (refused before anything is recorded), the quote and
// the charge agreeing exactly, mixed taxability and product overrides, tax
// after store-funded discounts, gift cards as payment (tax included), a
// confirmed zero-tax location, a stale tax version (fresh review required),
// the immutable snapshot and its database guards, historical orders, and
// isolation between businesses.

jest.setTimeout(120_000);

const T1 = TENANT_1_MOCHA_HOUSE_ID;
const tenant = tenantContextFor(T1);
const STATE_PPM = 60_000; // 6%
const CITY_PPM = 12_500; // 1.25%

// The exact rounding the calculation uses, written out independently.
const halfUp = (amount: number, ppm: number) =>
  Math.floor((amount * ppm * 2 + 1_000_000) / 2_000_000);

describe('V1 Sales Tax PR 2 — checkout tax (integration)', () => {
  const suffix = randomUUID().slice(0, 8);
  const originalEnv = { ...process.env };
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let checkout: CheckoutService;
  let locationId: string;
  let productId: string;
  let sizeSelection: { groupId: string; optionIds: string[] }[];
  let groceryProductId: string;
  let categoryId: string;
  let foodClassId: string;
  let groceryClassId: string;
  let confirmerId: string;
  const created = { promotions: [] as string[], giftCards: [] as string[] };

  const sql = async (text: string, values: unknown[] = []) => {
    const client = new Client({
      connectionString: process.env.DATABASE_URL!.split('?')[0],
    });
    await client.connect();
    try {
      return await client.query(text, values);
    } finally {
      await client.end();
    }
  };

  const body = (
    overrides: Partial<LabelledCheckoutRequest> = {},
  ): LabelledCheckoutRequest => ({
    clientRef: `tax_${randomUUID()}`,
    locationId,
    guest: { name: 'Tax Guest', phone: '5551239999' },
    lines: [{ productId, quantity: 2, selections: sizeSelection }],
    ...overrides,
  });

  const quote = (request: LabelledCheckoutRequest) =>
    checkout.quoteCheckout(
      {
        locationId: request.locationId,
        lines: request.lines,
        couponCode: request.couponCode ?? null,
        giftCardCode: request.giftCardCode ?? null,
      },
      undefined,
      tenant,
    );

  async function refusal(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (error instanceof ConflictException) {
        return (error.getResponse() as { code?: string }).code ?? null;
      }
      throw error;
    }
    throw new Error('expected a refusal');
  }

  // A confirmed version for the location: the database guard only lets a
  // DRAFT gain taxes, then become CONFIRMED (superseding the previous one).
  async function confirmVersion(
    components: { name: string; ratePpm: number; classIds: string[] }[],
  ) {
    const latest = await prisma.locationTaxVersion.aggregate({
      where: { tenantId: T1, locationId },
      _max: { version: true },
    });
    const draft = await prisma.locationTaxVersion.create({
      data: {
        tenantId: T1,
        locationId,
        version: (latest._max.version ?? 0) + 1,
        status: 'DRAFT',
      },
    });
    for (const [i, c] of components.entries()) {
      const row = await prisma.locationTaxComponent.create({
        data: {
          tenantId: T1,
          versionId: draft.id,
          name: c.name,
          jurisdiction: i === 0 ? 'STATE' : 'CITY',
          ratePpm: c.ratePpm,
          displayOrder: i,
        },
      });
      await prisma.locationTaxComponentClass.createMany({
        data: c.classIds.map((taxClassId) => ({
          tenantId: T1,
          componentId: row.id,
          taxClassId,
        })),
      });
    }
    const now = new Date();
    await prisma.locationTaxVersion.updateMany({
      where: { tenantId: T1, locationId, status: 'CONFIRMED' },
      data: { status: 'SUPERSEDED', supersededAt: now },
    });
    await prisma.locationTaxVersion.update({
      where: { id: draft.id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: now,
        confirmedByInternalUserId: confirmerId,
      },
    });
    return draft.id;
  }

  const standardVersion = () =>
    confirmVersion([
      {
        name: 'Michigan sales tax',
        ratePpm: STATE_PPM,
        classIds: [foodClassId, groceryClassId],
      },
      {
        name: 'City prepared food tax',
        ratePpm: CITY_PPM,
        classIds: [foodClassId],
      },
    ]);

  async function giftCard(balanceMinorUnits: number) {
    const code = generateGiftCardCode();
    const canonical = canonicalizeGiftCardCode(code)!;
    const card = await prisma.giftCard.create({
      data: {
        tenantId: T1,
        codeHash: hashGiftCardCode(canonical),
        last4: canonical.slice(-4),
        status: 'ACTIVE',
        originalValueMinorUnits: balanceMinorUnits,
        balanceMinorUnits,
        currency: 'USD',
        transactions: {
          create: {
            type: 'ISSUANCE',
            amountMinorUnits: balanceMinorUnits,
            balanceAfterMinorUnits: balanceMinorUnits,
          },
        },
      },
    });
    created.giftCards.push(card.id);
    return code;
  }

  async function coupon(discountValue: number) {
    const code = `TAX${randomUUID().slice(0, 8)}`.toUpperCase();
    const promotion = await prisma.promotion.create({
      data: {
        tenantId: T1,
        name: `Tax coupon ${code}`,
        kind: 'COUPON',
        code,
        discountType: 'FIXED_AMOUNT',
        discountValue,
        appliesToAllLocations: true,
      },
    });
    created.promotions.push(promotion.id);
    return code;
  }

  const orderOf = (orderId: string) =>
    prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { taxSnapshot: true, paymentAttempt: true },
    });

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYMENT_PROVIDER = 'fake';
    process.env.GIFT_CARD_CODE_SECRET = 'checkout-tax-spec-secret';
    delete process.env.SALES_TAX_ENABLED;
    moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        RedisModule,
        LocationsModule,
        CustomerAuthModule,
        InternalAuthModule,
        CustomersModule,
        LoyaltyModule,
        PromotionsModule,
        GiftCardsModule,
        PaymentModule,
      ],
      providers: [CheckoutService],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    checkout = moduleRef.get(CheckoutService);
    await removeTaxSettingsForTest([T1]);

    const location = await prisma.location.findUniqueOrThrow({
      where: { tenantId_slug: { tenantId: T1, slug: 'dearborn-heights' } },
    });
    locationId = location.id;
    const product = await prisma.product.findUniqueOrThrow({
      where: { tenantId_slug: { tenantId: T1, slug: 'drip-coffee' } },
      include: {
        modifierGroups: {
          include: { modifierGroup: { include: { options: true } } },
        },
      },
    });
    productId = product.id;
    const size = product.modifierGroups[0].modifierGroup;
    sizeSelection = [
      {
        groupId: size.id,
        optionIds: [size.options.find((o) => o.name === 'Medium')!.id],
      },
    ];
    categoryId = product.categoryId;
    confirmerId = (
      await prisma.internalUser.findFirstOrThrow({
        where: { tenantId: T1 },
        select: { id: true },
      })
    ).id;
    foodClassId = (
      await prisma.taxClass.create({
        data: {
          tenantId: T1,
          name: 'Prepared Food',
          systemKey: 'PREPARED_FOOD',
        },
      })
    ).id;
    groceryClassId = (
      await prisma.taxClass.create({
        data: { tenantId: T1, name: 'Grocery' },
      })
    ).id;
    // A second product on the same menu, overridden to Grocery.
    const grocery = await prisma.product.create({
      data: {
        tenantId: T1,
        name: 'Tax Beans Bag',
        slug: `tax-beans-${suffix}`,
        categoryId,
        basePrice: 1299,
        taxClassId: groceryClassId,
      },
    });
    groceryProductId = grocery.id;
    const menu = await prisma.locationMenu.findFirstOrThrow({
      where: { tenantId: T1, locationId, isActive: true },
    });
    await prisma.menuProduct.create({
      data: {
        tenantId: T1,
        menuId: menu.menuId,
        productId: groceryProductId,
        isActive: true,
      },
    });
    await createTestTenantB(prisma);
  });

  afterAll(async () => {
    try {
      const attemptIds = (
        await prisma.paymentAttempt.findMany({
          where: checkoutAttemptsOfThisSuite(),
          select: { id: true },
        })
      ).map((a) => a.id);
      const orderIds = (
        await prisma.order.findMany({
          where: { paymentAttemptId: { in: attemptIds } },
          select: { id: true },
        })
      ).map((o) => o.id);
      await removeTaxSettingsForTest([T1]);
      await prisma.orderPromotionRedemption.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.giftCardTransaction.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.orderGiftCardRedemption.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.orderLine.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.orderStatusHistory.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.outboxEvent.deleteMany({
        where: { aggregateType: 'Order', aggregateId: { in: orderIds } },
      });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      await removePaymentRecoveryRecordsForTest(attemptIds);
      await prisma.paymentAttempt.deleteMany({
        where: { id: { in: attemptIds } },
      });
      await prisma.checkoutSession.deleteMany({
        where: checkoutSessionsOfThisSuite(),
      });
      await prisma.giftCardTransaction.deleteMany({
        where: { giftCardId: { in: created.giftCards } },
      });
      await prisma.giftCard.deleteMany({
        where: { id: { in: created.giftCards } },
      });
      await prisma.promotionCustomerUsage.deleteMany({
        where: { promotionId: { in: created.promotions } },
      });
      await prisma.promotion.deleteMany({
        where: { id: { in: created.promotions } },
      });
      await prisma.menuProduct.deleteMany({
        where: { productId: groceryProductId },
      });
      await prisma.product.deleteMany({ where: { id: groceryProductId } });
      await removeTestTenantB(prisma);
    } finally {
      await moduleRef?.close();
      process.env = { ...originalEnv };
    }
  });

  afterEach(() => {
    delete process.env.SALES_TAX_ENABLED;
  });
  const enableTax = () => {
    process.env.SALES_TAX_ENABLED = '1';
  };

  it('switched off, checkout is exactly as before: no tax, no snapshot, version 2', async () => {
    const request = body();
    const q = await quote(request);
    expect(q.taxStatus).toBe('DISABLED');
    expect(q.tax).toBeNull();
    expect(q.total).toBe(q.subtotal);
    const confirmation = await submitCheckout(
      checkout,
      request,
      undefined,
      tenant,
    );
    expect(confirmation.taxMinorUnits).toBe(0);
    expect(confirmation.tax).toBeNull();
    expect(confirmation.total).toBe(q.subtotal);
    const order = await orderOf(confirmation.orderId);
    expect(order.taxMinorUnits).toBe(0);
    expect(order.taxSnapshot).toBeNull();
    expect(order.paymentAttempt.amount).toBe(q.subtotal);
  });

  it('switched on, a location without confirmed settings cannot take orders (nothing recorded)', async () => {
    enableTax();
    const request = body();
    const q = await quote(request);
    expect(q.taxStatus).toBe('NOT_CONFIGURED');
    expect(q.tax).toBeNull();
    expect(
      await refusal(submitCheckout(checkout, request, undefined, tenant)),
    ).toBe(CHECKOUT_TAX_NOT_CONFIGURED);
    expect(
      await prisma.paymentAttempt.count({
        where: attemptsOfCheckout(request.clientRef),
      }),
    ).toBe(0);
  });

  it('quotes, charges and snapshots exactly the same tax', async () => {
    enableTax();
    await standardVersion();
    const request = body();
    const q = await quote(request);
    expect(q.taxStatus).toBe('CALCULATED');
    const state = halfUp(q.subtotal, STATE_PPM);
    const city = halfUp(q.subtotal, CITY_PPM);
    expect(
      q.tax!.components.map((c) => [c.name, c.ratePercent, c.taxMinorUnits]),
    ).toEqual([
      ['Michigan sales tax', '6', state],
      ['City prepared food tax', '1.25', city],
    ]);
    expect(q.tax!.taxMinorUnits).toBe(state + city);
    expect(q.total).toBe(q.subtotal + state + city);

    const confirmation = await submitCheckout(
      checkout,
      { ...request, taxQuoteToken: q.tax!.taxQuoteToken },
      undefined,
      tenant,
    );
    expect(confirmation.taxMinorUnits).toBe(state + city);
    expect(confirmation.total).toBe(q.total);
    expect(confirmation.externalPaymentMinorUnits).toBe(q.total);
    expect(confirmation.tax!.components.map((c) => c.taxMinorUnits)).toEqual([
      state,
      city,
    ]);
    expect(confirmation.tax!.lineTaxMinorUnits).toEqual([state + city]);

    const order = await orderOf(confirmation.orderId);
    expect(order.paymentAttempt.amount).toBe(q.total);
    expect(order.taxMinorUnits).toBe(state + city);
    expect(order.taxSnapshot).toMatchObject({
      locationTaxVersionId: q.tax!.taxVersionId,
      taxVersion: q.tax!.taxVersion,
      source: 'BUILT_IN',
      pricesIncludeTax: false,
      merchandiseSubtotal: q.subtotal,
      discountMinorUnits: 0,
      taxableMinorUnits: q.subtotal,
      taxMinorUnits: state + city,
      totalMinorUnits: q.total,
      giftCardTenderMinorUnits: 0,
      chargedMinorUnits: q.total,
    });
    const detail = order.taxSnapshot!.detail as {
      lines: { taxClassName: string; taxableMinorUnits: number }[];
      components: { taxClassNames: string[] }[];
    };
    expect(detail.lines[0]).toMatchObject({
      taxClassName: 'Prepared Food',
      taxableMinorUnits: q.subtotal,
    });
    expect(detail.components.map((c) => [...c.taxClassNames].sort())).toEqual([
      ['Grocery', 'Prepared Food'],
      ['Prepared Food'],
    ]);
  });

  it('applies each tax only to its classes (a Grocery override pays state tax only)', async () => {
    enableTax();
    const request = body({
      lines: [
        { productId, quantity: 1, selections: sizeSelection },
        { productId: groceryProductId, quantity: 1, selections: [] },
      ],
    });
    const q = await quote(request);
    const food = q.subtotal - 1299;
    const state = halfUp(food + 1299, STATE_PPM);
    const city = halfUp(food, CITY_PPM);
    expect(
      q.tax!.components.map((c) => [c.taxableMinorUnits, c.taxMinorUnits]),
    ).toEqual([
      [food + 1299, state],
      [food, city],
    ]);
    const confirmation = await submitCheckout(
      checkout,
      { ...request, taxQuoteToken: q.tax!.taxQuoteToken },
      undefined,
      tenant,
    );
    expect(confirmation.taxMinorUnits).toBe(state + city);
    // Every line's tax adds up to the order's tax.
    expect(confirmation.tax!.lineTaxMinorUnits.reduce((a, b) => a + b, 0)).toBe(
      state + city,
    );
  });

  it('taxes after a store-funded discount, and treats a gift card as payment', async () => {
    enableTax();
    const code = await coupon(100);
    const card = await giftCard(300);
    const request = body({ couponCode: code, giftCardCode: card });
    const q = await quote(request);
    const discounted = q.subtotal - 100;
    const tax = halfUp(discounted, STATE_PPM) + halfUp(discounted, CITY_PPM);
    expect(q.tax!.taxMinorUnits).toBe(tax);
    expect(q.total).toBe(discounted + tax);
    // The gift card pays part of the total, tax included; it never lowers
    // the taxable price.
    expect(q.giftCard!.appliedMinorUnits).toBe(300);
    expect(q.amountDueAfterGiftCardMinorUnits).toBe(discounted + tax - 300);

    const confirmation = await submitCheckout(
      checkout,
      { ...request, taxQuoteToken: q.tax!.taxQuoteToken },
      undefined,
      tenant,
    );
    const order = await orderOf(confirmation.orderId);
    expect(order.taxMinorUnits).toBe(tax);
    expect(order.paymentAttempt.amount).toBe(discounted + tax - 300);
    expect(order.taxSnapshot).toMatchObject({
      discountMinorUnits: 100,
      taxableMinorUnits: discounted,
      giftCardTenderMinorUnits: 300,
      chargedMinorUnits: discounted + tax - 300,
    });
  });

  it('a gift card can pay the whole total including tax (nothing charged externally)', async () => {
    enableTax();
    const request = body({ giftCardCode: await giftCard(100_000) });
    const q = await quote(request);
    expect(q.giftCard!.appliedMinorUnits).toBe(q.total);
    expect(q.amountDueAfterGiftCardMinorUnits).toBe(0);
    const confirmation = await submitCheckout(
      checkout,
      { ...request, taxQuoteToken: q.tax!.taxQuoteToken },
      undefined,
      tenant,
    );
    expect(confirmation.giftCardTenderMinorUnits).toBe(q.total);
    expect(confirmation.externalPaymentMinorUnits).toBe(0);
    expect(confirmation.taxMinorUnits).toBe(q.tax!.taxMinorUnits);
  });

  // PR #94 review — tax classes can change without a new tax version: a
  // category class or a product override changed after the quote must be
  // reviewed again, refused before any payment attempt or hold exists.
  async function expectStaleRefusedThenFreshCharged(
    change: () => Promise<void>,
    undo: () => Promise<void>,
    lines?: LabelledCheckoutRequest['lines'],
  ) {
    enableTax();
    const request = body(lines ? { lines } : {});
    const q = await quote(request);
    await change();
    try {
      expect(
        await refusal(
          submitCheckout(
            checkout,
            { ...request, taxQuoteToken: q.tax!.taxQuoteToken },
            undefined,
            tenant,
          ),
        ),
      ).toBe(CHECKOUT_TAX_CHANGED);
      // Nothing recorded: no payment attempt, saved checkout or hold.
      expect(
        await prisma.paymentAttempt.count({
          where: attemptsOfCheckout(request.clientRef),
        }),
      ).toBe(0);
      // Same version, yet a different tax: the fresh quote shows it, and
      // exactly that is charged.
      const fresh = await quote(request);
      expect(fresh.tax!.taxVersionId).toBe(q.tax!.taxVersionId);
      expect(fresh.tax!.taxMinorUnits).not.toBe(q.tax!.taxMinorUnits);
      expect(fresh.tax!.taxQuoteToken).not.toBe(q.tax!.taxQuoteToken);
      const confirmation = await submitCheckout(
        checkout,
        { ...request, taxQuoteToken: fresh.tax!.taxQuoteToken },
        undefined,
        tenant,
      );
      expect(confirmation.total).toBe(fresh.total);
      expect(confirmation.taxMinorUnits).toBe(fresh.tax!.taxMinorUnits);
    } finally {
      await undo();
    }
  }

  it('refuses a quote made stale by a category tax class change (same tax version)', async () => {
    await expectStaleRefusedThenFreshCharged(
      async () => {
        await prisma.category.update({
          where: { id: categoryId },
          data: { taxClassId: groceryClassId, taxClassReviewedAt: new Date() },
        });
      },
      async () => {
        await prisma.category.update({
          where: { id: categoryId },
          data: { taxClassId: null, taxClassReviewedAt: null },
        });
      },
    );
  });

  it('refuses a quote made stale by a product tax override (same tax version)', async () => {
    await expectStaleRefusedThenFreshCharged(
      async () => {
        await prisma.product.update({
          where: { id: productId },
          data: { taxClassId: groceryClassId },
        });
      },
      async () => {
        await prisma.product.update({
          where: { id: productId },
          data: { taxClassId: null },
        });
      },
    );
  });

  it('accepts an unchanged quote: the same inputs give the same token', async () => {
    enableTax();
    const request = body();
    const [a, b] = [await quote(request), await quote(request)];
    expect(a.tax!.taxQuoteToken).toBe(b.tax!.taxQuoteToken);
    expect(a.tax!.taxQuoteToken).toMatch(/^tq1_[A-Za-z0-9_-]{43}$/);
    // A token for another cart is not this cart's.
    const other = await quote(
      body({ lines: [{ productId, quantity: 3, selections: sizeSelection }] }),
    );
    expect(other.tax!.taxQuoteToken).not.toBe(a.tax!.taxQuoteToken);
    expect(
      await refusal(
        submitCheckout(
          checkout,
          { ...request, taxQuoteToken: other.tax!.taxQuoteToken },
          undefined,
          tenant,
        ),
      ),
    ).toBe(CHECKOUT_TAX_CHANGED);
  });

  it('refuses a checkout whose tax was not reviewed, or changed since the quote', async () => {
    enableTax();
    const request = body();
    const q = await quote(request);
    // No version presented.
    expect(
      await refusal(submitCheckout(checkout, request, undefined, tenant)),
    ).toBe(CHECKOUT_TAX_CHANGED);
    // The settings change between the quote and the order.
    await confirmVersion([
      {
        name: 'Michigan sales tax',
        ratePpm: 70_000,
        classIds: [foodClassId, groceryClassId],
      },
    ]);
    const stale = body();
    expect(
      await refusal(
        submitCheckout(
          checkout,
          { ...stale, taxQuoteToken: q.tax!.taxQuoteToken },
          undefined,
          tenant,
        ),
      ),
    ).toBe(CHECKOUT_TAX_CHANGED);
    expect(
      await prisma.paymentAttempt.count({
        where: attemptsOfCheckout(stale.clientRef),
      }),
    ).toBe(0);
    // A fresh quote shows the new tax, and that one is charged.
    const fresh = await quote(stale);
    expect(fresh.tax!.taxMinorUnits).toBe(halfUp(fresh.subtotal, 70_000));
    const confirmation = await submitCheckout(
      checkout,
      { ...stale, taxQuoteToken: fresh.tax!.taxQuoteToken },
      undefined,
      tenant,
    );
    expect(confirmation.taxMinorUnits).toBe(fresh.tax!.taxMinorUnits);
  });

  it('a confirmed zero-tax location charges zero tax and still snapshots it', async () => {
    enableTax();
    await confirmVersion([]);
    const request = body();
    const q: CheckoutQuoteResponse = await quote(request);
    expect(q.taxStatus).toBe('CALCULATED');
    expect(q.tax).toMatchObject({ taxMinorUnits: 0, components: [] });
    expect(q.total).toBe(q.subtotal);
    const confirmation = await submitCheckout(
      checkout,
      { ...request, taxQuoteToken: q.tax!.taxQuoteToken },
      undefined,
      tenant,
    );
    expect(confirmation.taxMinorUnits).toBe(0);
    expect(confirmation.tax).toMatchObject({
      taxMinorUnits: 0,
      components: [],
    });
    const order = await orderOf(confirmation.orderId);
    expect(order.taxSnapshot).toMatchObject({ taxMinorUnits: 0 });
  });

  it('an order is created with the tax it was charged, whatever the switch says later', async () => {
    enableTax();
    await standardVersion();
    const request = body();
    const q = await quote(request);
    // Stop before the order exists: save the checkout and charge it, then
    // create the order from the frozen checkout with the switch OFF.
    const confirmation = await submitCheckout(
      checkout,
      { ...request, taxQuoteToken: q.tax!.taxQuoteToken },
      undefined,
      tenant,
    );
    const order = await orderOf(confirmation.orderId);
    delete process.env.SALES_TAX_ENABLED;
    // Replaying the paid checkout returns the same taxed order.
    const replay = await submitCheckout(
      checkout,
      { ...request, taxQuoteToken: q.tax!.taxQuoteToken },
      undefined,
      tenant,
    );
    expect(replay.orderId).toBe(order.id);
    expect(replay.taxMinorUnits).toBe(order.taxMinorUnits);
  });

  it('the database keeps the tax and its snapshot exactly as charged', async () => {
    enableTax();
    const request = body();
    const q = await quote(request);
    const confirmation = await submitCheckout(
      checkout,
      { ...request, taxQuoteToken: q.tax!.taxQuoteToken },
      undefined,
      tenant,
    );
    const order = await orderOf(confirmation.orderId);
    const snapshot = order.taxSnapshot!;
    // The tax charged never changes.
    await expect(
      prisma.order.update({
        where: { id: order.id },
        data: { taxMinorUnits: order.taxMinorUnits + 1 },
      }),
    ).rejects.toThrow();
    // The snapshot is never changed or deleted.
    await expect(
      prisma.orderTaxSnapshot.update({
        where: { id: snapshot.id },
        data: { taxableMinorUnits: 0 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.orderTaxSnapshot.delete({ where: { id: snapshot.id } }),
    ).rejects.toThrow();
    // The saved checkout went with its order; the attempt was version 3.
    expect(
      await prisma.checkoutSnapshot.count({
        where: { paymentAttemptId: order.paymentAttemptId },
      }),
    ).toBe(0);
    expect(order.paymentAttempt.amount).toBe(
      order.subtotal -
        order.promotionDiscountMinorUnits -
        order.rewardDiscountMinorUnits +
        order.taxMinorUnits -
        order.giftCardTenderMinorUnits,
    );
  });

  it('the database refuses a snapshot that disagrees with its order', async () => {
    // A snapshot whose amounts disagree with its order is refused.
    const taxed = await prisma.orderTaxSnapshot.findFirstOrThrow({
      where: { tenantId: T1 },
      include: { order: true },
    });
    const untaxedOrder = await prisma.order.findFirstOrThrow({
      where: {
        tenantId: T1,
        taxSnapshot: null,
        paymentAttempt: checkoutAttemptsOfThisSuite(),
      },
    });
    await expect(
      prisma.orderTaxSnapshot.create({
        data: {
          tenantId: T1,
          orderId: untaxedOrder.id,
          locationTaxVersionId: taxed.locationTaxVersionId,
          taxVersion: taxed.taxVersion,
          source: 'BUILT_IN',
          currency: 'USD',
          merchandiseSubtotal: untaxedOrder.subtotal,
          discountMinorUnits: 0,
          taxableMinorUnits: untaxedOrder.subtotal,
          taxMinorUnits: 5,
          totalMinorUnits: untaxedOrder.subtotal + 5,
          giftCardTenderMinorUnits: 0,
          chargedMinorUnits: untaxedOrder.subtotal + 5,
          detail: {},
        },
      }),
    ).rejects.toThrow();
  });

  it('keeps every business to its own tax settings and products', async () => {
    const tax = new SalesTaxService(BUILT_IN_SALES_TAX_PROVIDER);
    const bLocation = await prisma.location.create({
      data: { tenantId: TEST_TENANT_B_ID, name: 'B', slug: `tax-b-${suffix}` },
    });
    try {
      // Business B's location has no settings of its own; Mocha House's
      // never apply to it, and Mocha House cannot read B's location at all.
      await expect(
        tax.planCheckoutTax(prisma, {
          tenantId: TEST_TENANT_B_ID,
          locationId: bLocation.id,
          currency: 'USD',
          lines: [{ productId, lineTotal: 100 }],
          regularPlan: null,
          rewardPlan: null,
        }),
      ).rejects.toBeInstanceOf(TaxNotConfiguredError);
      await expect(
        tax.planCheckoutTax(prisma, {
          tenantId: T1,
          locationId: bLocation.id,
          currency: 'USD',
          lines: [{ productId, lineTotal: 100 }],
          regularPlan: null,
          rewardPlan: null,
        }),
      ).rejects.toBeInstanceOf(TaxNotConfiguredError);
      // Another business's product is never classified here.
      const bCategory = await prisma.category.create({
        data: {
          tenantId: TEST_TENANT_B_ID,
          name: 'B',
          slug: `tax-b-${suffix}`,
        },
      });
      const bProduct = await prisma.product.create({
        data: {
          tenantId: TEST_TENANT_B_ID,
          name: 'B',
          slug: `tax-b-${suffix}`,
          categoryId: bCategory.id,
        },
      });
      await expect(
        tax.planCheckoutTax(prisma, {
          tenantId: T1,
          locationId,
          currency: 'USD',
          lines: [{ productId: bProduct.id, lineTotal: 100 }],
          regularPlan: null,
          rewardPlan: null,
        }),
      ).rejects.toThrow();
      await prisma.product.delete({ where: { id: bProduct.id } });
      await prisma.category.delete({ where: { id: bCategory.id } });
    } finally {
      await prisma.location.delete({ where: { id: bLocation.id } });
    }
  });

  it('historical orders keep no tax', async () => {
    const before = await prisma.order.count({
      where: { tenantId: T1, taxMinorUnits: { gt: 0 }, taxSnapshot: null },
    });
    expect(before).toBe(0);
  });

  it('a tampered frozen tax is never fulfilled', () => {
    const tax = new SalesTaxService(BUILT_IN_SALES_TAX_PROVIDER);
    const frozen = {
      currency: 'USD',
      lines: [{ productId: 'p', lineTotal: 1000 }],
      regularPlan: null,
      rewardPlan: null,
      totals: { promotionDiscount: 0, rewardDiscount: 0 },
    };
    const components = [
      {
        componentId: 'c',
        name: 'State',
        jurisdiction: 'STATE',
        ratePpm: STATE_PPM,
        taxClassIds: ['k'],
      },
    ];
    const good = {
      taxVersionId: 'v',
      taxVersion: 1,
      source: 'BUILT_IN' as const,
      classes: [{ id: 'k', name: 'Prepared Food' }],
      components,
      lineTaxClassIds: ['k'],
      result: BUILT_IN_SALES_TAX_PROVIDER.calculate({
        currency: 'USD',
        lines: [
          { lineIndex: 0, productId: 'p', lineTotal: 1000, taxClassId: 'k' },
        ],
        discounts: [],
        components,
      }),
    };
    expect(() => tax.verifyFrozenTax(good, frozen)).not.toThrow();
    // A key order change (as JSONB stores it) is not a difference.
    const reverseKeys = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverseKeys)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([k, v]) => [k, reverseKeys(v)]),
            )
          : value;
    const reordered = reverseKeys(good.result) as typeof good.result;
    expect(Object.keys(reordered)[0]).not.toBe(Object.keys(good.result)[0]);
    expect(() =>
      tax.verifyFrozenTax({ ...good, result: reordered }, frozen),
    ).not.toThrow();
    // Any change to the inputs or the result is.
    expect(() =>
      tax.verifyFrozenTax(
        { ...good, components: [{ ...components[0], ratePpm: 50_000 }] },
        frozen,
      ),
    ).toThrow();
    expect(() =>
      tax.verifyFrozenTax(
        { ...good, result: { ...good.result, taxMinorUnits: 61 } },
        frozen,
      ),
    ).toThrow();
    expect(() =>
      tax.verifyFrozenTax({ ...good, lineTaxClassIds: ['other'] }, frozen),
    ).toThrow();
  });

  it('records a version-3 saved checkout before the charge', async () => {
    enableTax();
    const request = body();
    const q = await quote(request);
    // Start a two-part checkout so the saved checkout can be inspected:
    // a failing order write keeps the payment and its saved checkout.
    await sql(`CREATE OR REPLACE FUNCTION tax_pr2_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated order failure'; END $$;
      CREATE TRIGGER tax_pr2_fail BEFORE INSERT ON "Order" FOR EACH ROW EXECUTE FUNCTION tax_pr2_fail();`);
    try {
      await submitCheckout(
        checkout,
        { ...request, taxQuoteToken: q.tax!.taxQuoteToken },
        undefined,
        tenant,
      ).catch(() => undefined);
    } finally {
      await sql(`DROP TRIGGER IF EXISTS tax_pr2_fail ON "Order";
        DROP FUNCTION IF EXISTS tax_pr2_fail();`);
    }
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      where: attemptsOfCheckout(request.clientRef),
    });
    const saved = await prisma.checkoutSnapshot.findUniqueOrThrow({
      where: { paymentAttemptId: attempt.id },
    });
    expect(saved.version).toBe(3);
    const payload = saved.payload as unknown as SavedCheckout;
    expect(payload.frozen!.totals.tax).toBe(q.tax!.taxMinorUnits);
    expect(payload.frozen!.tax!.taxVersionId).toBe(q.tax!.taxVersionId);
    expect(attempt.amount).toBe(q.total);
    // Recovery creates the order from the frozen checkout, with its tax —
    // even with the switch off by then (it was charged).
    delete process.env.SALES_TAX_ENABLED;
    const recovered = await checkout.recoverFulfilment(attempt.id, T1);
    expect(recovered.taxMinorUnits).toBe(q.tax!.taxMinorUnits);
    expect(recovered.total).toBe(q.total);
  });
});
