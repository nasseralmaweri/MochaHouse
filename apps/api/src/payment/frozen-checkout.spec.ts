/* eslint-disable @typescript-eslint/require-await -- controlled provider doubles are async by contract */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma } from '@mocha-house/database';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeFinancialHoldsForTest,
  removePaymentRecoveryRecordsForTest,
  removeTestTenantB,
  tenantContextFor,
} from '@mocha-house/testing';
import type {
  ChargeRequest,
  ChargeResult,
  PaymentProvider,
} from '@mocha-house/integrations';
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
import { PaymentModule } from './payment.module';
import { PAYMENT_PROVIDER } from './payment-provider.token';
import { CheckoutService } from '../orders/application/checkout.service';
import { LOYALTY_CONFIGURATION_KEY } from '../loyalty/application/loyalty.service';
import type {
  FrozenCheckout,
  SavedCheckout,
} from '../orders/application/checkout-snapshot';
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

// ESP-03 PR 7 — tenant-scoped payment keys and frozen checkout prices. Real
// services and a real disposable database; the provider is a controlled
// double and failures are real database failures. A paid checkout whose
// order could not be created is fulfilled later (customer retry, automatic
// or support recovery) from its FROZEN checkout (version 2), never
// re-priced:
//   * later menu, modifier, price, promotion, reward and earning-rate
//     changes do not change the order or what it earns;
//   * a frozen checkout that does not add up, or no longer matches the
//     payment or the submitted items, is never fulfilled;
//   * promotion limits, Mocha Bean and gift-card balances are never
//     exceeded or driven negative — the payment is kept for review;
//   * a suspended business or a location no longer taking orders receives
//     no order — the payment is kept for review;
//   * version-1 saved checkouts (payments from before PR 7) still work;
//   * concurrent recoveries create one order with each effect once, and
//     nothing is ever charged twice.

// A saved checkout as stored: version 2 always carries its frozen block.
type Payload = SavedCheckout & { frozen: FrozenCheckout };
const frozenOf = (payload: unknown) => (payload as Payload).frozen;

class ControlledProvider implements PaymentProvider {
  readonly name = 'controlled-test';
  readonly acceptsPayments = true;
  calls: ChargeRequest[] = [];
  behavior: (req: ChargeRequest) => Promise<ChargeResult> = async (req) => ({
    outcome: 'succeeded',
    providerReference: `ctl_${req.idempotencyKey}`,
  });
  charge(req: ChargeRequest): Promise<ChargeResult> {
    this.calls.push(req);
    return this.behavior(req);
  }
  reset(): void {
    this.calls = [];
    this.behavior = async (req) => ({
      outcome: 'succeeded',
      providerReference: `ctl_${req.idempotencyKey}`,
    });
  }
}

async function outcomeOf<T>(fn: () => Promise<T>): Promise<{
  ok: boolean;
  value?: T;
  status?: number;
  response?: unknown;
}> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const err = e as {
      getStatus?: () => number;
      getResponse?: () => unknown;
    };
    return {
      ok: false,
      status: err.getStatus?.(),
      response: err.getResponse?.(),
    };
  }
}

jest.setTimeout(240_000);

describe('ESP-03 PR 7 frozen checkout (integration)', () => {
  const provider = new ControlledProvider();
  const t1 = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  const suffix = randomUUID().slice(0, 8);
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let checkout: CheckoutService;
  let locationId: string;
  let menuId: string;
  let productId: string;
  let otherProductId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;
  let mediumAdjustment: number;
  let productName: string;
  const originalEnv = { ...process.env };
  const created = {
    promotions: [] as string[],
    rewards: [] as string[],
    bonuses: [] as string[],
    giftCards: [] as string[],
  };

  const sql = async (text: string) => {
    const client = new Client({
      connectionString: process.env.DATABASE_URL!.split('?')[0],
    });
    await client.connect();
    try {
      await client.query(text);
    } finally {
      await client.end();
    }
  };
  async function withFailingOrderWrites<T>(fn: () => Promise<T>): Promise<T> {
    await sql(`
      CREATE OR REPLACE FUNCTION esp03_pr7_simulated_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated database failure'; END $$;`);
    await sql(`CREATE TRIGGER esp03_pr7_fail BEFORE INSERT ON "Order"
      FOR EACH ROW EXECUTE FUNCTION esp03_pr7_simulated_failure();`);
    try {
      return await fn();
    } finally {
      await sql(`DROP TRIGGER IF EXISTS esp03_pr7_fail ON "Order";`);
    }
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.GIFT_CARD_CODE_SECRET = 'frozen-checkout-spec-secret';
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
    })
      .overrideProvider(PAYMENT_PROVIDER)
      .useValue(provider)
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    checkout = moduleRef.get(CheckoutService);

    const location = await prisma.location.findUniqueOrThrow({
      where: {
        tenantId_slug: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          slug: 'dearborn-heights',
        },
      },
    });
    const product = await prisma.product.findUniqueOrThrow({
      where: {
        tenantId_slug: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          slug: 'drip-coffee',
        },
      },
      include: {
        modifierGroups: {
          include: { modifierGroup: { include: { options: true } } },
        },
      },
    });
    locationId = location.id;
    productId = product.id;
    productName = product.name;
    menuId = (
      await prisma.locationMenu.findFirstOrThrow({
        where: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          locationId,
          isActive: true,
        },
      })
    ).menuId;
    const group = product.modifierGroups[0].modifierGroup;
    sizeGroupId = group.id;
    const medium = group.options.find((o) => o.name === 'Medium')!;
    mediumOptionId = medium.id;
    mediumAdjustment = medium.priceAdjustment;
    otherProductId = (
      await prisma.product.create({
        data: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          name: 'PR7 Other',
          slug: `pr7-other-${suffix}`,
          categoryId: product.categoryId,
          basePrice: 100,
        },
      })
    ).id;
    await createTestTenantB(prisma);
  });

  afterAll(async () => {
    await sql(`DROP TRIGGER IF EXISTS esp03_pr7_fail ON "Order";
      DROP FUNCTION IF EXISTS esp03_pr7_simulated_failure();`);
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
    const bonuses = await prisma.orderLoyaltyBonus.findMany({
      where: { orderId: { in: orderIds } },
      select: { id: true },
    });
    await prisma.orderLoyaltyBonusItem.deleteMany({
      where: { orderLoyaltyBonusId: { in: bonuses.map((b) => b.id) } },
    });
    await prisma.orderLoyaltyBonus.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.mochaBeanLedgerEntry.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.orderPromotionRedemption.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.orderLoyaltyRewardRedemption.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.giftCardTransaction.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.orderGiftCardRedemption.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.orderLine.deleteMany({ where: { orderId: { in: orderIds } } });
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
    await prisma.loyaltyReward.deleteMany({
      where: { id: { in: created.rewards } },
    });
    await prisma.loyaltyBonusPromotionProduct.deleteMany({
      where: { promotionId: { in: created.bonuses } },
    });
    await prisma.loyaltyBonusPromotion.deleteMany({
      where: { id: { in: created.bonuses } },
    });
    const customers = await prisma.customer.findMany({
      where: {
        externalProvider: 'test',
        externalSubject: { startsWith: `test-customer-pr7-${suffix}` },
      },
      select: { id: true },
    });
    const customerIds = customers.map((c) => c.id);
    await prisma.mochaBeanLedgerEntry.deleteMany({
      where: { loyaltyAccount: { customerId: { in: customerIds } } },
    });
    await prisma.customerLoyaltyAccount.deleteMany({
      where: { customerId: { in: customerIds } },
    });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.product.deleteMany({ where: { id: otherProductId } });
    await removeTestTenantB(prisma);
    await moduleRef.close();
    process.env = { ...originalEnv };
  });

  beforeEach(() => provider.reset());

  // --- fixtures ------------------------------------------------------------------

  const body = (
    overrides: Partial<LabelledCheckoutRequest> = {},
  ): LabelledCheckoutRequest => ({
    clientRef: `fz_${randomUUID()}`,
    locationId,
    guest: { name: 'Frozen Guest', phone: '5551237777' },
    lines: [
      {
        productId,
        quantity: 2,
        selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
      },
    ],
    ...overrides,
  });

  async function member(beans = 100) {
    const identity = {
      provider: 'test' as const,
      subject: `test-customer-pr7-${suffix}-${randomUUID()}`,
      email: `pr7-${randomUUID().slice(0, 8)}@example.com`,
      name: null,
      emailVerified: null,
    };
    const customer = await prisma.customer.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        externalProvider: identity.provider,
        externalSubject: identity.subject,
        email: identity.email,
      },
    });
    const account = await prisma.customerLoyaltyAccount.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        customerId: customer.id,
        balance: beans,
      },
    });
    return { identity, customer, account };
  }

  async function coupon(
    discountValue: number,
    limits: { total?: number; perCustomer?: number } = {},
  ) {
    const code = `PR7${randomUUID().slice(0, 8)}`.toUpperCase();
    const promotion = await prisma.promotion.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        name: `PR7 coupon ${code}`,
        kind: 'COUPON',
        code,
        discountType: 'FIXED_AMOUNT',
        discountValue,
        appliesToAllLocations: true,
        totalRedemptionLimit: limits.total ?? null,
        perCustomerRedemptionLimit: limits.perCustomer ?? null,
      },
    });
    created.promotions.push(promotion.id);
    return { code, promotion };
  }

  async function reward(beanCost: number, fixedAmountMinorUnits: number) {
    const row = await prisma.loyaltyReward.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        name: `PR7 reward ${randomUUID().slice(0, 8)}`,
        type: 'FIXED_AMOUNT',
        beanCost,
        fixedAmountMinorUnits,
      },
    });
    created.rewards.push(row.id);
    return row;
  }

  async function extraBeansBonus(bonusValue: number) {
    const row = await prisma.loyaltyBonusPromotion.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        name: `PR7 bonus ${randomUUID()}`,
        type: 'EXTRA_BEANS',
        bonusValue,
        isActive: true,
        appliesToAllLocations: true,
        eligibleProducts: { create: [{ productId }] },
      },
    });
    created.bonuses.push(row.id);
    return row;
  }

  async function giftCard(balanceMinorUnits: number) {
    const code = generateGiftCardCode();
    const canonical = canonicalizeGiftCardCode(code)!;
    const card = await prisma.giftCard.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
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
    return { id: card.id, code };
  }

  const attemptOf = (key: string) =>
    prisma.paymentAttempt.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
      where: attemptsOfCheckout(key),
    });
  const snapshotOf = (paymentAttemptId: string) =>
    prisma.checkoutSnapshot.findUnique({ where: { paymentAttemptId } });
  const ordersFor = (paymentAttemptId: string) =>
    prisma.order.findMany({
      where: { paymentAttemptId },
      include: {
        lines: true,
        mochaBeanEntries: true,
        loyaltyBonus: true,
        giftCardRedemption: true,
        promotionRedemption: true,
        loyaltyRewardRedemption: true,
      },
    });
  const caseOf = (paymentAttemptId: string) =>
    prisma.paymentReconciliationCase.findUnique({
      where: {
        tenantId_paymentAttemptId: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          paymentAttemptId,
        },
      },
    });
  const recover = (paymentAttemptId: string) =>
    checkout.recoverFulfilment(paymentAttemptId, TENANT_1_MOCHA_HOUSE_ID);

  // A charged payment whose order could not be created (a real write
  // failure inside the order transaction), kept for review.
  async function chargedWithoutOrder(
    request: LabelledCheckoutRequest = body(),
    identity?: Awaited<ReturnType<typeof member>>['identity'],
  ) {
    const first = await withFailingOrderWrites(() =>
      outcomeOf(() => submitCheckout(checkout, request, identity, t1)),
    );
    expect(first.ok).toBe(false);
    const attempt = await attemptOf(request.clientRef);
    expect(attempt).toMatchObject({
      status: 'SUCCEEDED',
      paymentState: 'SUCCEEDED',
      reconciliationRequired: true,
      fulfilmentStatus: 'NEEDS_REVIEW',
    });
    expect(await ordersFor(attempt.id)).toHaveLength(0);
    expect(provider.calls).toHaveLength(1);
    return { request, attempt };
  }

  // A payment kept for review: no order, the saved checkout and the open
  // case remain, never charged again.
  async function expectKeptForReview(paymentAttemptId: string) {
    expect(await ordersFor(paymentAttemptId)).toHaveLength(0);
    expect(await snapshotOf(paymentAttemptId)).not.toBeNull();
    expect(await caseOf(paymentAttemptId)).toMatchObject({
      status: 'OPEN',
      reasonCode: 'FULFILMENT_FAILED',
    });
    expect(
      await prisma.paymentAttempt.findUniqueOrThrow({
        where: { id: paymentAttemptId },
      }),
    ).toMatchObject({
      status: 'SUCCEEDED',
      paymentState: 'SUCCEEDED',
      reconciliationRequired: true,
    });
    expect(provider.calls).toHaveLength(1);
  }

  async function tamper(
    paymentAttemptId: string,
    change: (payload: Payload) => void,
  ) {
    const saved = (await snapshotOf(paymentAttemptId))!;
    const payload = structuredClone(saved.payload) as unknown as Payload;
    change(payload);
    await prisma.checkoutSnapshot.update({
      where: { paymentAttemptId },
      data: { payload: payload as unknown as Prisma.InputJsonObject },
    });
  }

  async function setEarningRate(rate: number | null) {
    const where = {
      tenantId_key: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        key: LOYALTY_CONFIGURATION_KEY,
      },
    };
    const existing = await prisma.loyaltyConfiguration.findUnique({ where });
    if (rate === null) {
      return existing?.earningRatePerDollar ?? null;
    }
    await prisma.loyaltyConfiguration.upsert({
      where,
      create: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        key: LOYALTY_CONFIGURATION_KEY,
        earningRatePerDollar: rate,
      },
      update: { earningRatePerDollar: rate },
    });
    return existing?.earningRatePerDollar ?? null;
  }

  // --- the saved checkout ---------------------------------------------------------

  describe('freezing the checkout before the charge', () => {
    it('saves version 2 with the priced lines, modifiers, totals and the amount charged', async () => {
      let seen: Awaited<ReturnType<typeof snapshotOf>> = null;
      provider.behavior = async (req) => {
        seen = await snapshotOf((await attemptOf(req.idempotencyKey)).id);
        return { outcome: 'succeeded', providerReference: 'ref_frozen' };
      };
      const request = body();
      await submitCheckout(checkout, request, undefined, t1);
      const attempt = await attemptOf(request.clientRef);
      const [order] = await ordersFor(attempt.id);
      expect(seen).not.toBeNull();
      const saved = seen!;
      expect(saved.version).toBe(2);
      const frozen = frozenOf(saved.payload);
      expect(frozen.lines).toEqual([
        expect.objectContaining({
          productId,
          productName,
          quantity: 2,
          unitPrice: order.lines[0].unitPrice,
          lineTotal: order.lines[0].lineTotal,
          currency: 'USD',
          selectionSnapshots: [
            expect.objectContaining({
              groupId: sizeGroupId,
              optionIds: [mediumOptionId],
              optionNames: ['Medium'],
            }),
          ],
        }),
      ]);
      expect(frozen.totals).toEqual({
        subtotal: order.subtotal,
        promotionDiscount: 0,
        rewardDiscount: 0,
        giftCardTender: 0,
        charge: attempt.amount,
      });
      expect(frozen.loyalty).toBeNull();
    });
  });

  // --- catalog and offer changes after payment --------------------------------

  describe('changes after payment', () => {
    it('menu, modifier, price, promotion, reward, bonus and earning-rate changes never change the order or what it earns', async () => {
      const { identity, account } = await member(100);
      const { code, promotion } = await coupon(100);
      const rw = await reward(5, 100);
      const bonus = await extraBeansBonus(3);
      const card = await giftCard(300);
      const previousRate = await setEarningRate(1);
      const { request, attempt } = await chargedWithoutOrder(
        body({
          couponCode: code,
          loyaltyRewardId: rw.id,
          giftCardCode: card.code,
        }),
        identity,
      );
      const saved = (await snapshotOf(attempt.id))!;
      const frozen = frozenOf(saved.payload);
      const subtotal: number = frozen.subtotal;
      // owed = subtotal - 100 coupon - 100 reward; 300 on the gift card.
      expect(attempt.amount).toBe(subtotal - 100 - 100 - 300);
      const earnBeans: number = frozen.loyalty!.earnBeans;
      expect(earnBeans).toBe(Math.floor((subtotal - 200) / 100));
      expect(frozen.loyalty!.bonus!.totalBonusBeans).toBe(6);

      // Everything a business might change after the customer paid.
      await prisma.locationProductPriceOverride.upsert({
        where: {
          locationId_menuId_productId: { locationId, menuId, productId },
        },
        create: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          locationId,
          menuId,
          productId,
          price: 9_999,
        },
        update: { price: 9_999 },
      });
      await prisma.modifierOption.update({
        where: { id: mediumOptionId },
        data: { priceAdjustment: mediumAdjustment + 500 },
      });
      await prisma.product.update({
        where: { id: productId },
        data: { name: `${productName} (renamed)`, isActive: false },
      });
      await prisma.promotion.update({
        where: { id: promotion.id },
        data: { discountValue: 5, isActive: false },
      });
      await prisma.loyaltyReward.update({
        where: { id: rw.id },
        data: { fixedAmountMinorUnits: 1, beanCost: 50 },
      });
      await prisma.loyaltyBonusPromotion.update({
        where: { id: bonus.id },
        data: { isActive: false },
      });
      await setEarningRate(10);
      try {
        const recovered = await recover(attempt.id);
        const [order] = await ordersFor(attempt.id);
        expect(recovered.orderId).toBe(order.id);
        expect(order).toMatchObject({
          subtotal,
          promotionDiscountMinorUnits: 100,
          rewardDiscountMinorUnits: 100,
          giftCardTenderMinorUnits: 300,
        });
        expect(order.lines).toEqual([
          expect.objectContaining({
            productId,
            productName,
            quantity: 2,
            unitPrice: frozen.lines[0].unitPrice,
            lineTotal: frozen.lines[0].lineTotal,
          }),
        ]);
        expect(order.giftCardRedemption?.amountMinorUnits).toBe(300);
        expect(order.promotionRedemption).not.toBeNull();
        expect(order.loyaltyRewardRedemption).not.toBeNull();
        const byType = Object.fromEntries(
          order.mochaBeanEntries.map((e) => [e.type, e.amount]),
        );
        expect(byType).toEqual({
          REDEEM: -5,
          EARN: earnBeans,
          BONUS_EARN: 6,
        });
        expect(order.loyaltyBonus?.totalBonusBeans).toBe(6);
        expect(
          (
            await prisma.customerLoyaltyAccount.findUniqueOrThrow({
              where: { id: account.id },
            })
          ).balance,
        ).toBe(100 - 5 + earnBeans + 6);
        expect(
          (await prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } }))
            .balanceMinorUnits,
        ).toBe(0);
        expect(await snapshotOf(attempt.id)).toBeNull();
        expect(provider.calls).toHaveLength(1);

        // The customer's retry returns the same order; nothing again.
        const retry = await submitCheckout(checkout, request, identity, t1);
        expect(retry.orderId).toBe(order.id);
        expect(await ordersFor(attempt.id)).toHaveLength(1);
        expect(provider.calls).toHaveLength(1);
      } finally {
        await prisma.locationProductPriceOverride.deleteMany({
          where: { locationId, menuId, productId },
        });
        await prisma.modifierOption.update({
          where: { id: mediumOptionId },
          data: { priceAdjustment: mediumAdjustment },
        });
        await prisma.product.update({
          where: { id: productId },
          data: { name: productName, isActive: true },
        });
        if (previousRate === null) {
          await prisma.loyaltyConfiguration.deleteMany({
            where: {
              tenantId: TENANT_1_MOCHA_HOUSE_ID,
              key: LOYALTY_CONFIGURATION_KEY,
            },
          });
        } else {
          await setEarningRate(previousRate);
        }
      }
    });
  });

  // --- integrity of the frozen checkout --------------------------------------

  describe('a frozen checkout that does not add up is never fulfilled', () => {
    it.each([
      [
        'a cheaper item substituted at the same total',
        (p: Payload) => {
          p.frozen.lines[0].productId = otherProductId;
        },
      ],
      [
        'a line total that does not match its price',
        (p: Payload) => {
          p.frozen.lines[0].lineTotal += 1;
        },
      ],
      [
        'a charge that differs from the payment',
        (p: Payload) => {
          p.frozen.subtotal += 100;
          p.frozen.totals.subtotal += 100;
          p.frozen.lines[0].unitPrice += 50;
          p.frozen.lines[0].lineTotal += 100;
          p.frozen.totals.charge += 100;
        },
      ],
      [
        'a discount that does not match its plan',
        (p: Payload) => {
          p.frozen.totals.promotionDiscount = 50;
          p.frozen.totals.charge -= 50;
        },
      ],
      [
        'a different quantity from the submitted checkout',
        (p: Payload) => {
          p.lines[0].quantity = 1;
        },
      ],
    ])('%s', async (_label, change) => {
      const { request, attempt } = await chargedWithoutOrder();
      await tamper(attempt.id, change);
      expect((await outcomeOf(() => recover(attempt.id))).ok).toBe(false);
      const retry = await outcomeOf(() =>
        submitCheckout(checkout, request, undefined, t1),
      );
      expect(retry.status).toBe(409);
      expect(JSON.stringify(retry.response)).toContain('manual review');
      await expectKeptForReview(attempt.id);
    });

    it('a malformed frozen checkout is refused as unreadable, never guessed', async () => {
      const { attempt } = await chargedWithoutOrder();
      await tamper(attempt.id, (p) => {
        delete (p.frozen as Partial<FrozenCheckout>).totals;
      });
      expect((await outcomeOf(() => recover(attempt.id))).ok).toBe(false);
      await expectKeptForReview(attempt.id);
    });

    it('a retry substituting a different item at the same total is refused and never charged', async () => {
      const { request, attempt } = await chargedWithoutOrder();
      const substituted = await outcomeOf(() =>
        submitCheckout(
          checkout,
          {
            ...request,
            lines: [
              {
                productId,
                quantity: 2,
                selections: [
                  { groupId: sizeGroupId, optionIds: [mediumOptionId] },
                ],
              },
              { productId: otherProductId, quantity: 1, selections: [] },
            ],
          },
          undefined,
          t1,
        ),
      );
      expect(substituted.ok).toBe(false);
      expect(provider.calls).toHaveLength(1);
      await expectKeptForReview(attempt.id);
    });
  });

  // --- limits and balances (owner decisions D2 and D3) ---------------------

  describe('limits and balances at fulfilment', () => {
    it('an exhausted promotion limit keeps the payment for review; the frozen discount is honoured once the limit allows', async () => {
      const { code, promotion } = await coupon(100, { total: 1 });
      const { attempt } = await chargedWithoutOrder(body({ couponCode: code }));
      // Another order used the last redemption meanwhile.
      await prisma.promotion.update({
        where: { id: promotion.id },
        data: { redemptionCount: 1 },
      });
      expect((await outcomeOf(() => recover(attempt.id))).ok).toBe(false);
      await expectKeptForReview(attempt.id);
      expect(
        (
          await prisma.promotion.findUniqueOrThrow({
            where: { id: promotion.id },
          })
        ).redemptionCount,
      ).toBe(1);
      // Support raises the limit: the order is created with the frozen
      // discount, counted once, never charged again.
      await prisma.promotion.update({
        where: { id: promotion.id },
        data: { totalRedemptionLimit: 2 },
      });
      await recover(attempt.id);
      const [order] = await ordersFor(attempt.id);
      expect(order.promotionDiscountMinorUnits).toBe(100);
      expect(
        (
          await prisma.promotion.findUniqueOrThrow({
            where: { id: promotion.id },
          })
        ).redemptionCount,
      ).toBe(2);
      expect(provider.calls).toHaveLength(1);
    });

    it('a per-customer limit reached meanwhile keeps the payment for review', async () => {
      const { identity, customer } = await member(0);
      const { code, promotion } = await coupon(100, { perCustomer: 1 });
      const { attempt } = await chargedWithoutOrder(
        body({ couponCode: code }),
        identity,
      );
      await prisma.promotionCustomerUsage.create({
        data: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          promotionId: promotion.id,
          customerId: customer.id,
          usedCount: 1,
        },
      });
      expect((await outcomeOf(() => recover(attempt.id))).ok).toBe(false);
      await expectKeptForReview(attempt.id);
    });

    it('a promotion deleted meanwhile keeps the payment for review', async () => {
      const { code, promotion } = await coupon(100);
      const { attempt } = await chargedWithoutOrder(body({ couponCode: code }));
      // ESP-03 PR 8 — a promotion with a hold cannot be deleted; as for a
      // payment from before PR 8 (no hold), the deletion goes through.
      await removeFinancialHoldsForTest({ promotionIds: [promotion.id] });
      await prisma.promotion.delete({ where: { id: promotion.id } });
      expect((await outcomeOf(() => recover(attempt.id))).ok).toBe(false);
      await expectKeptForReview(attempt.id);
    });

    it('Mocha Beans spent elsewhere meanwhile keep the payment for review; never a negative balance', async () => {
      const { identity, account } = await member(10);
      const rw = await reward(10, 100);
      const { attempt } = await chargedWithoutOrder(
        body({ loyaltyRewardId: rw.id }),
        identity,
      );
      await prisma.customerLoyaltyAccount.update({
        where: { id: account.id },
        data: { balance: 3 },
      });
      expect((await outcomeOf(() => recover(attempt.id))).ok).toBe(false);
      await expectKeptForReview(attempt.id);
      expect(
        (
          await prisma.customerLoyaltyAccount.findUniqueOrThrow({
            where: { id: account.id },
          })
        ).balance,
      ).toBe(3);
    });

    it('a reward deleted meanwhile keeps the payment for review; no Beans are spent', async () => {
      const { identity, account } = await member(10);
      const rw = await reward(10, 100);
      const { attempt } = await chargedWithoutOrder(
        body({ loyaltyRewardId: rw.id }),
        identity,
      );
      await prisma.loyaltyReward.delete({ where: { id: rw.id } });
      expect((await outcomeOf(() => recover(attempt.id))).ok).toBe(false);
      await expectKeptForReview(attempt.id);
      expect(
        (
          await prisma.customerLoyaltyAccount.findUniqueOrThrow({
            where: { id: account.id },
          })
        ).balance,
      ).toBe(10);
    });

    it('a gift card drained meanwhile keeps the payment for review; never a negative balance', async () => {
      const card = await giftCard(300);
      const { attempt } = await chargedWithoutOrder(
        body({ giftCardCode: card.code }),
      );
      await prisma.giftCard.update({
        where: { id: card.id },
        data: { balanceMinorUnits: 100 },
      });
      expect((await outcomeOf(() => recover(attempt.id))).ok).toBe(false);
      await expectKeptForReview(attempt.id);
      expect(
        (await prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } }))
          .balanceMinorUnits,
      ).toBe(100);
    });
  });

  // --- operational restrictions (owner decision D5) ------------------------

  describe('operational restrictions still apply', () => {
    it('a suspended business receives no order; the payment is kept and fulfilled once reinstated', async () => {
      const { attempt } = await chargedWithoutOrder();
      await prisma.tenant.update({
        where: { id: TENANT_1_MOCHA_HOUSE_ID },
        data: { status: 'SUSPENDED', suspensionReason: 'REQUESTED' },
      });
      try {
        expect((await outcomeOf(() => recover(attempt.id))).ok).toBe(false);
        await expectKeptForReview(attempt.id);
      } finally {
        await prisma.tenant.update({
          where: { id: TENANT_1_MOCHA_HOUSE_ID },
          data: { status: 'ACTIVE', suspensionReason: null },
        });
      }
      await recover(attempt.id);
      expect(await ordersFor(attempt.id)).toHaveLength(1);
      expect(provider.calls).toHaveLength(1);
    });

    it('an inactive location receives no order', async () => {
      const { attempt } = await chargedWithoutOrder();
      await prisma.location.update({
        where: { id: locationId },
        data: { isActive: false },
      });
      try {
        expect((await outcomeOf(() => recover(attempt.id))).ok).toBe(false);
        await expectKeptForReview(attempt.id);
      } finally {
        await prisma.location.update({
          where: { id: locationId },
          data: { isActive: true },
        });
      }
    });
  });

  // --- concurrency, tenancy and compatibility ------------------------------

  describe('exactly once', () => {
    it('concurrent recoveries and retries create one order and apply every effect once', async () => {
      const { identity, account } = await member(100);
      const { code, promotion } = await coupon(100, { total: 5 });
      const rw = await reward(5, 100);
      await extraBeansBonus(2);
      const card = await giftCard(200);
      const { request, attempt } = await chargedWithoutOrder(
        body({
          couponCode: code,
          loyaltyRewardId: rw.id,
          giftCardCode: card.code,
        }),
        identity,
      );
      const frozen = frozenOf((await snapshotOf(attempt.id))!.payload);
      const results = await Promise.all([
        outcomeOf(() => recover(attempt.id)),
        outcomeOf(() => recover(attempt.id)),
        outcomeOf(() => recover(attempt.id)),
        outcomeOf(() => submitCheckout(checkout, request, identity, t1)),
        outcomeOf(() => submitCheckout(checkout, request, identity, t1)),
      ]);
      const orders = await ordersFor(attempt.id);
      expect(orders).toHaveLength(1);
      for (const r of results.filter((x) => x.ok)) {
        expect((r.value as { orderId: string }).orderId).toBe(orders[0].id);
      }
      // Anything that lost the race can retry and meets the same order.
      expect((await recover(attempt.id)).orderId).toBe(orders[0].id);
      expect(provider.calls).toHaveLength(1);
      expect(
        (
          await prisma.promotion.findUniqueOrThrow({
            where: { id: promotion.id },
          })
        ).redemptionCount,
      ).toBe(1);
      expect(
        (await prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } }))
          .balanceMinorUnits,
      ).toBe(0);
      expect(
        await prisma.giftCardTransaction.count({
          where: { giftCardId: card.id, orderId: orders[0].id },
        }),
      ).toBe(1);
      const entries = await prisma.mochaBeanLedgerEntry.findMany({
        where: { orderId: orders[0].id },
      });
      expect(entries.map((e) => e.type).sort()).toEqual([
        'BONUS_EARN',
        'EARN',
        'REDEEM',
      ]);
      expect(
        (
          await prisma.customerLoyaltyAccount.findUniqueOrThrow({
            where: { id: account.id },
          })
        ).balance,
      ).toBe(
        100 -
          5 +
          frozen.loyalty!.earnBeans +
          frozen.loyalty!.bonus!.totalBonusBeans,
      );
    });

    it('another business can neither recover a payment nor reuse its payment key', async () => {
      const { attempt } = await chargedWithoutOrder();
      const other = await outcomeOf(() =>
        checkout.recoverFulfilment(attempt.id, TEST_TENANT_B_ID),
      );
      expect(other.ok).toBe(false);
      await expectKeptForReview(attempt.id);
      // The same payment key under another business is refused by the
      // database (keys are unique per business and globally).
      await expect(
        prisma.paymentAttempt.create({
          data: {
            tenantId: TEST_TENANT_B_ID,
            idempotencyKey: attempt.idempotencyKey,
            provider: 'controlled-test',
            amount: attempt.amount,
            currency: attempt.currency,
          },
        }),
      ).rejects.toThrow(/Unique constraint/);
      const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'PaymentAttempt'
          AND indexname = 'PaymentAttempt_tenantId_idempotencyKey_key'`;
      expect(indexes).toHaveLength(1);
      // Lookups are scoped: the key under the wrong business finds nothing.
      expect(
        await prisma.paymentAttempt.findUnique({
          where: {
            tenantId_idempotencyKey: {
              tenantId: TEST_TENANT_B_ID,
              idempotencyKey: attempt.idempotencyKey,
            },
          },
        }),
      ).toBeNull();
    });
  });

  describe('version-1 saved checkouts (payments from before PR 7)', () => {
    async function asVersion1(paymentAttemptId: string) {
      const saved = (await snapshotOf(paymentAttemptId))!;
      const base = {
        ...(saved.payload as unknown as Payload),
      } as Partial<Payload>;
      delete base.frozen;
      await prisma.checkoutSnapshot.update({
        where: { paymentAttemptId },
        data: {
          version: 1,
          payload: base as unknown as Prisma.InputJsonObject,
        },
      });
    }

    it('are still fulfilled by re-pricing, exactly once', async () => {
      const { identity } = await member(100);
      const { code } = await coupon(100);
      const { request, attempt } = await chargedWithoutOrder(
        body({ couponCode: code }),
        identity,
      );
      await asVersion1(attempt.id);
      const recovered = await recover(attempt.id);
      const [order] = await ordersFor(attempt.id);
      expect(recovered.orderId).toBe(order.id);
      expect(order.promotionDiscountMinorUnits).toBe(100);
      expect(order.mochaBeanEntries.map((e) => e.type)).toContain('EARN');
      expect(
        (await submitCheckout(checkout, request, identity, t1)).orderId,
      ).toBe(order.id);
      expect(provider.calls).toHaveLength(1);
    });

    it('keep the version-1 rule: a price change keeps the payment for review', async () => {
      const { attempt } = await chargedWithoutOrder();
      await asVersion1(attempt.id);
      await prisma.locationProductPriceOverride.upsert({
        where: {
          locationId_menuId_productId: { locationId, menuId, productId },
        },
        create: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          locationId,
          menuId,
          productId,
          price: 9_999,
        },
        update: { price: 9_999 },
      });
      try {
        expect((await outcomeOf(() => recover(attempt.id))).ok).toBe(false);
        await expectKeptForReview(attempt.id);
      } finally {
        await prisma.locationProductPriceOverride.deleteMany({
          where: { locationId, menuId, productId },
        });
      }
      await recover(attempt.id);
      expect(await ordersFor(attempt.id)).toHaveLength(1);
      expect(provider.calls).toHaveLength(1);
    });
  });
});
