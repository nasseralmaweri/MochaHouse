import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConflictException, HttpException } from '@nestjs/common';
import { FakePaymentProvider } from '@mocha-house/integrations';
import type { CheckoutRequest } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { LocationsModule } from '../locations/locations.module';
import { CustomersModule } from '../customers/customers.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { CheckoutService } from '../orders/application/checkout.service';
import { PAYMENT_PROVIDER } from '../orders/infrastructure/payment-provider.token';
import type { CustomerIdentity } from '../customer-auth/infrastructure/customer-identity';
import { LoyaltyModule } from './loyalty.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';
import { LoyaltyService } from './application/loyalty.service';

// Milestone 7A — Mocha Beans earning integrated into the real checkout
// transaction, against the local Postgres instance. Requires the seed to
// have run (uses the seeded dearborn-heights / drip-coffee fixture, where
// one medium drip coffee is $4.00 -> 4 Mocha Beans).
describe('Mocha Beans earning on checkout (integration)', () => {
  let prisma: PrismaService;
  let checkoutService: CheckoutService;
  let loyaltyService: LoyaltyService;
  let paymentProvider: FakePaymentProvider;
  let locationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;

  const KEY_PREFIX = 'test_loyalty_';
  const SUBJECT_PREFIX = 'test-loyalty-';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        LocationsModule,
        CustomersModule,
        CustomerAuthModule,
        InternalAuthModule,
        LoyaltyModule,
        PromotionsModule,
        GiftCardsModule,
      ],
      providers: [
        CheckoutService,
        { provide: PAYMENT_PROVIDER, useClass: FakePaymentProvider },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    checkoutService = moduleRef.get(CheckoutService);
    loyaltyService = moduleRef.get(LoyaltyService);
    paymentProvider = moduleRef.get(PAYMENT_PROVIDER);
    await prisma.$connect();

    const location = await prisma.location.findUniqueOrThrow({
      where: { slug: 'dearborn-heights' },
    });
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'drip-coffee' },
      include: {
        modifierGroups: {
          include: { modifierGroup: { include: { options: true } } },
        },
      },
    });
    locationId = location.id;
    productId = product.id;
    const sizeGroup = product.modifierGroups[0].modifierGroup;
    sizeGroupId = sizeGroup.id;

    // These assertions assume the default earning rate of 1 Bean / $1.
    // Pin the shared LoyaltyConfiguration singleton so this suite is
    // independent of test-file order (the settings suite mutates it).
    await prisma.loyaltyConfiguration.upsert({
      where: { key: 'company' },
      update: { earningRatePerDollar: 1 },
      create: { key: 'company', earningRatePerDollar: 1 },
    });
    mediumOptionId = sizeGroup.options.find((o) => o.name === 'Medium')!.id;
  });

  afterAll(async () => {
    // Customers this file creates use the 'test' provider with a
    // 'test-loyalty-' subject prefix. Deleting them cascades their
    // CustomerLoyaltyAccount and every MochaBeanLedgerEntry (EARN rows
    // included), so this must happen BEFORE the orders are removed.
    await prisma.customer.deleteMany({
      where: {
        externalProvider: 'test',
        externalSubject: { startsWith: SUBJECT_PREFIX },
      },
    });

    const attempts = await prisma.paymentAttempt.findMany({
      where: { idempotencyKey: { startsWith: KEY_PREFIX } },
      select: { id: true },
    });
    const attemptIds = attempts.map((a) => a.id);
    if (attemptIds.length > 0) {
      const orders = await prisma.order.findMany({
        where: { paymentAttemptId: { in: attemptIds } },
        select: { id: true },
      });
      const orderIds = orders.map((o) => o.id);
      // Any EARN entries were removed with their customer above; this
      // catches the edge case of a guest order that somehow has entries.
      await prisma.mochaBeanLedgerEntry.deleteMany({
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
      await prisma.paymentAttempt.deleteMany({
        where: { id: { in: attemptIds } },
      });
    }

    await prisma.$disconnect();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildRequest(
    overrides: Partial<CheckoutRequest> = {},
  ): CheckoutRequest {
    return {
      idempotencyKey: `${KEY_PREFIX}${randomUUID()}`,
      locationId,
      guest: { name: 'Loyalty Guest', phone: '5551234567' },
      lines: [
        {
          productId,
          quantity: 1,
          selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
        },
      ],
      ...overrides,
    };
  }

  function identity(suffix: string): CustomerIdentity {
    return {
      provider: 'test',
      subject: `${SUBJECT_PREFIX}${suffix}`,
      email: `${suffix}@example.com`,
      name: null,
      emailVerified: null,
    };
  }

  async function balanceOf(customerId: string): Promise<number> {
    const account = await prisma.customerLoyaltyAccount.findUnique({
      where: { customerId },
      select: { balance: true },
    });
    return account?.balance ?? 0;
  }

  async function ledgerFor(customerId: string) {
    const account = await prisma.customerLoyaltyAccount.findUnique({
      where: { customerId },
      select: { id: true },
    });
    if (!account) {
      return [];
    }
    return prisma.mochaBeanLedgerEntry.findMany({
      where: { loyaltyAccountId: account.id },
      orderBy: { createdAt: 'asc' },
    });
  }

  it('an authenticated checkout earns floor(subtotal/100) Beans, once', async () => {
    const id = identity(randomUUID());
    // 3 x medium drip coffee = 3 x $4.00 = $12.00 -> 12 Beans.
    const confirmation = await checkoutService.checkout(
      buildRequest({
        lines: [
          {
            productId,
            quantity: 3,
            selections: [
              { groupId: sizeGroupId, optionIds: [mediumOptionId] },
            ],
          },
        ],
      }),
      id,
    );
    expect(confirmation.subtotal).toBe(1200);

    const customer = await prisma.customer.findUniqueOrThrow({
      where: {
        externalProvider_externalSubject: {
          externalProvider: id.provider,
          externalSubject: id.subject,
        },
      },
    });

    const ledger = await ledgerFor(customer.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe('EARN');
    expect(ledger[0].amount).toBe(12);
    expect(ledger[0].orderId).toBe(confirmation.orderId);
    expect(ledger[0].reason).toBeNull();
    expect(ledger[0].actorInternalUserId).toBeNull();

    // Materialized balance matches the ledger sum.
    expect(await balanceOf(customer.id)).toBe(12);
  });

  it('a guest checkout earns no Beans and creates no loyalty account', async () => {
    const confirmation = await checkoutService.checkout(buildRequest());

    const entries = await prisma.mochaBeanLedgerEntry.findMany({
      where: { orderId: confirmation.orderId },
    });
    expect(entries).toHaveLength(0);
  });

  it('a checkout replay (same idempotency key) does not earn a second time', async () => {
    const id = identity(randomUUID());
    const request = buildRequest();

    const first = await checkoutService.checkout(request, id);
    const second = await checkoutService.checkout(request, id);
    expect(second.orderId).toBe(first.orderId);

    const customer = await prisma.customer.findUniqueOrThrow({
      where: {
        externalProvider_externalSubject: {
          externalProvider: id.provider,
          externalSubject: id.subject,
        },
      },
    });

    const ledger = await ledgerFor(customer.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].amount).toBe(4); // one medium drip coffee = $4.00
    expect(await balanceOf(customer.id)).toBe(4);
  });

  it('a declined payment earns no Beans', async () => {
    const id = identity(randomUUID());
    const request = buildRequest({
      guest: {
        name: 'Declined',
        phone: FakePaymentProvider.DECLINE_TEST_PHONE,
      },
    });

    await expect(
      checkoutService.checkout(request, id),
    ).rejects.toBeInstanceOf(HttpException);

    const customer = await prisma.customer.findUnique({
      where: {
        externalProvider_externalSubject: {
          externalProvider: id.provider,
          externalSubject: id.subject,
        },
      },
    });
    // The customer may have been JIT-provisioned, but must have earned
    // nothing.
    if (customer) {
      expect(await balanceOf(customer.id)).toBe(0);
      expect(await ledgerFor(customer.id)).toHaveLength(0);
    }
  });

  it('payment succeeds but the order transaction fails: no Beans, no order', async () => {
    const id = identity(randomUUID());
    const request = buildRequest();
    jest
      .spyOn(prisma, '$transaction')
      .mockRejectedValueOnce(new Error('Simulated order transaction failure'));

    await expect(checkoutService.checkout(request, id)).rejects.toThrow(
      'Simulated order transaction failure',
    );

    const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { idempotencyKey: request.idempotencyKey },
    });
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.reconciliationRequired).toBe(true);

    const customer = await prisma.customer.findUniqueOrThrow({
      where: {
        externalProvider_externalSubject: {
          externalProvider: id.provider,
          externalSubject: id.subject,
        },
      },
    });
    expect(await balanceOf(customer.id)).toBe(0);
    expect(await ledgerFor(customer.id)).toHaveLength(0);
  });

  // Regression for the MAJOR review finding: loyalty-account preparation
  // now runs INSIDE the post-payment reconciliation try/catch, so a
  // non-P2002 failure there must flag reconciliationRequired exactly like
  // an order-transaction failure — never silently orphan a captured
  // payment.
  it('payment succeeds but loyalty-account preparation fails: no order, no Beans, reconciliationRequired set', async () => {
    const id = identity(randomUUID());
    const request = buildRequest();
    const spy = jest
      .spyOn(loyaltyService, 'ensureAccountForCustomer')
      .mockRejectedValueOnce(
        new Error('Simulated loyalty account preparation failure'),
      );

    await expect(checkoutService.checkout(request, id)).rejects.toThrow(
      'Simulated loyalty account preparation failure',
    );
    expect(spy).toHaveBeenCalledTimes(1);

    const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { idempotencyKey: request.idempotencyKey },
    });
    // The payment truthfully succeeded — must never be relabeled, and the
    // invariant "after payment capture: an Order exists OR
    // reconciliationRequired is set" must hold.
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.reconciliationRequired).toBe(true);
    expect(attempt.reconciliationReason).toContain(
      'Simulated loyalty account preparation failure',
    );
    expect(attempt.reconciliationDetectedAt).not.toBeNull();

    const order = await prisma.order.findUnique({
      where: { paymentAttemptId: attempt.id },
    });
    expect(order).toBeNull();

    const customer = await prisma.customer.findUniqueOrThrow({
      where: {
        externalProvider_externalSubject: {
          externalProvider: id.provider,
          externalSubject: id.subject,
        },
      },
    });
    expect(await balanceOf(customer.id)).toBe(0);
    expect(await ledgerFor(customer.id)).toHaveLength(0);

    // A retry with the same key recognises the reconciliation condition —
    // it never charges again, never silently succeeds.
    await expect(checkoutService.checkout(request, id)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('the ledger enforces exactly one EARN per order', async () => {
    const id = identity(randomUUID());
    const confirmation = await checkoutService.checkout(buildRequest(), id);

    const customer = await prisma.customer.findUniqueOrThrow({
      where: {
        externalProvider_externalSubject: {
          externalProvider: id.provider,
          externalSubject: id.subject,
        },
      },
    });
    const account = await prisma.customerLoyaltyAccount.findUniqueOrThrow({
      where: { customerId: customer.id },
    });

    await expect(
      prisma.mochaBeanLedgerEntry.create({
        data: {
          loyaltyAccountId: account.id,
          type: 'EARN',
          amount: 4,
          orderId: confirmation.orderId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
