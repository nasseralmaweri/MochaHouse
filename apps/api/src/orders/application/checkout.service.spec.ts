import 'dotenv/config';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  tenantContextFor,
  enrollTestCustomer,
  removePaymentRecoveryRecordsForTest,
} from '@mocha-house/testing';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import { FakePaymentProvider } from '@mocha-house/integrations';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationsModule } from '../../locations/locations.module';
import { CustomersModule } from '../../customers/customers.module';
import { CustomerAuthModule } from '../../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../../internal-auth/internal-auth.module';
import { LoyaltyModule } from '../../loyalty/loyalty.module';
import { PromotionsModule } from '../../promotions/promotions.module';
import { GiftCardsModule } from '../../gift-cards/gift-cards.module';
import { CheckoutService } from './checkout.service';
import { PAYMENT_PROVIDER } from '../infrastructure/payment-provider.token';
import { PaymentModule } from '../../payment/payment.module';
import type { CustomerIdentity } from '../../customer-auth/infrastructure/customer-identity';
import {
  attemptsOfCheckout,
  checkoutAttemptsOfThisSuite,
  submitCheckout,
  type LabelledCheckoutRequest,
} from '../../../test/checkout-session';

// Integration test against the real local Postgres instance (see
// infrastructure/local/compose.yml + apps/api/.env), exercising the full
// checkout orchestration exactly as CheckoutController would call it, but
// without going over HTTP. Requires `pnpm exec tsx prisma/seed.ts` to have
// been run — it uses the seeded "dearborn-heights" / "drip-coffee" fixture.
describe('CheckoutService (integration)', () => {
  let prisma: PrismaService;
  let checkoutService: CheckoutService;
  let paymentProvider: FakePaymentProvider;
  let locationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;

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
        PaymentModule,
      ],
      providers: [CheckoutService],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    checkoutService = moduleRef.get(CheckoutService);
    paymentProvider = moduleRef.get(PAYMENT_PROVIDER);
    await prisma.$connect();

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
    const sizeGroup = product.modifierGroups[0].modifierGroup;
    sizeGroupId = sizeGroup.id;
    mediumOptionId = sizeGroup.options.find((o) => o.name === 'Medium')!.id;
  });

  afterAll(async () => {
    // Every idempotencyKey this file creates starts with "test_" (see
    // buildRequest below) — clean up exactly those PaymentAttempts/Orders
    // so repeated runs don't accumulate permanent data, without touching
    // the seeded dearborn-heights/drip-coffee catalog fixture.
    const attempts = await prisma.paymentAttempt.findMany({
      where: checkoutAttemptsOfThisSuite(),
      select: { id: true },
    });
    const attemptIds = attempts.map((a) => a.id);
    if (attemptIds.length > 0) {
      const orders = await prisma.order.findMany({
        where: { paymentAttemptId: { in: attemptIds } },
        select: { id: true },
      });
      const orderIds = orders.map((o) => o.id);

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
      // ESP-03 PR 4 — a payment's saved checkout and reconciliation records
      // (append-only) go first, through the disposable-only test helper.
      await removePaymentRecoveryRecordsForTest(
        (
          await prisma.paymentAttempt.findMany({
            where: { id: { in: attemptIds } },
            select: { id: true },
          })
        ).map((a) => a.id),
      );
      await prisma.paymentAttempt.deleteMany({
        where: { id: { in: attemptIds } },
      });
    }

    // Every Customer this file creates uses the 'test' provider with a
    // 'test-customer-' subject prefix (see testCustomerIdentity below) —
    // Order.customerId already reverted to null above via the FK's
    // onDelete: SetNull, so this is safe regardless of ordering.
    await prisma.customer.deleteMany({
      where: {
        externalProvider: 'test',
        externalSubject: { startsWith: 'test-customer-' },
      },
    });

    await prisma.$disconnect();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildRequest(
    overrides: Partial<LabelledCheckoutRequest> = {},
  ): LabelledCheckoutRequest {
    return {
      clientRef: `test_${randomUUID()}`,
      locationId,
      guest: { name: 'Test Guest', phone: '5551234567' },
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

  async function testCustomerIdentity(
    suffix: string,
  ): Promise<CustomerIdentity> {
    const enrolled: CustomerIdentity = {
      provider: 'test',
      subject: `test-customer-${suffix}`,
      email: `${suffix}@example.com`,
      name: null,
      emailVerified: null,
    };
    await enrollTestCustomer(prisma, TENANT_1_MOCHA_HOUSE_ID, enrolled);
    return enrolled;
  }

  it('associates an authenticated checkout with the resolved Customer id (Milestone 4B)', async () => {
    const identity = await testCustomerIdentity(randomUUID());

    const confirmation = await submitCheckout(
      checkoutService,
      buildRequest(),
      identity,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: confirmation.orderId },
    });
    expect(order.customerId).not.toBeNull();

    const customer = await prisma.customer.findUniqueOrThrow({
      where: {
        tenantId_externalProvider_externalSubject: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          externalProvider: identity.provider,
          externalSubject: identity.subject,
        },
      },
    });
    expect(order.customerId).toBe(customer.id);
  });

  it('guest checkout (no customer identity) still creates an Order with customerId null', async () => {
    const confirmation = await submitCheckout(
      checkoutService,
      buildRequest(),
      undefined,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: confirmation.orderId },
    });
    expect(order.customerId).toBeNull();
  });

  it('resolves the same Customer across repeated authenticated checkouts by the same identity', async () => {
    const identity = await testCustomerIdentity(randomUUID());

    const first = await submitCheckout(
      checkoutService,
      buildRequest(),
      identity,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );
    const second = await submitCheckout(
      checkoutService,
      buildRequest(),
      identity,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );

    const orderA = await prisma.order.findUniqueOrThrow({
      where: { id: first.orderId },
    });
    const orderB = await prisma.order.findUniqueOrThrow({
      where: { id: second.orderId },
    });
    expect(orderA.customerId).not.toBeNull();
    expect(orderA.customerId).toBe(orderB.customerId);
  });

  it('creates a durable order, history row, and outbox event on a successful payment', async () => {
    const request = buildRequest();

    const confirmation = await submitCheckout(
      checkoutService,
      request,
      undefined,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );

    expect(confirmation.status).toBe('RECEIVED');
    expect(confirmation.subtotal).toBe(400); // 350 base + 50 medium adjustment
    expect(confirmation.orderNumber).toMatch(/^[A-Z0-9]{6}$/);
    expect(confirmation.accessToken).toHaveLength(32);

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: confirmation.orderId },
      include: { statusHistory: true, paymentAttempt: true, lines: true },
    });
    expect(order.paymentAttempt.status).toBe('SUCCEEDED');
    expect(order.paymentAttempt.idempotencyKey).toMatch(
      /^ck_[A-Za-z0-9_-]{43}$/,
    );
    expect(order.statusHistory).toHaveLength(1);
    expect(order.statusHistory[0].status).toBe('RECEIVED');
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0].unitPrice).toBe(400);

    const outboxEvents = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'Order', aggregateId: order.id },
    });
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0].status).toBe('PENDING');
  });

  it('ignores a client-submitted price and always uses the authoritative server price', async () => {
    const request = buildRequest();
    // CheckoutLineInput has no price field at all, but prove the point at
    // the wire boundary too: even if a client smuggled one in past the
    // TS contract (e.g. a hand-crafted HTTP request), it's never read.
    (request.lines[0] as unknown as Record<string, unknown>).unitPrice = 1;

    const confirmation = await submitCheckout(
      checkoutService,
      request,
      undefined,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );
    expect(confirmation.subtotal).toBe(400);
  });

  it('declines the fake payment and creates no order', async () => {
    const request = buildRequest({
      guest: {
        name: 'Decline Guest',
        phone: FakePaymentProvider.DECLINE_TEST_PHONE,
      },
    });

    await expect(
      submitCheckout(
        checkoutService,
        request,
        undefined,
        tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
      ),
    ).rejects.toBeInstanceOf(HttpException);

    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
      where: attemptsOfCheckout(request.clientRef),
    });
    expect(attempt.status).toBe('DECLINED');

    const order = await prisma.order.findUnique({
      where: { paymentAttemptId: attempt.id },
    });
    expect(order).toBeNull();
  });

  it('does not create a payment attempt or charge for an invalid cart', async () => {
    const request = buildRequest({
      lines: [{ productId: 'not-a-real-product', quantity: 1, selections: [] }],
    });

    await expect(
      submitCheckout(
        checkoutService,
        request,
        undefined,
        tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    const attempt = await prisma.paymentAttempt.findFirst({
      orderBy: { createdAt: 'desc' },
      where: attemptsOfCheckout(request.clientRef),
    });
    expect(attempt).toBeNull();
  });

  it('is idempotent: resubmitting the same idempotency key never charges or creates a second order', async () => {
    const request = buildRequest();

    const first = await submitCheckout(
      checkoutService,
      request,
      undefined,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );
    const second = await submitCheckout(
      checkoutService,
      request,
      undefined,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );

    expect(second.orderId).toBe(first.orderId);
    expect(second.accessToken).toBe(first.accessToken);

    const attempts = await prisma.paymentAttempt.count({
      where: attemptsOfCheckout(request.clientRef),
    });
    expect(attempts).toBe(1);

    const orders = await prisma.order.count({
      where: { paymentAttempt: attemptsOfCheckout(request.clientRef) },
    });
    expect(orders).toBe(1);
  });

  it('a retry with the same key after a simulated lost response returns the existing result without a second charge', async () => {
    // Mirrors the corrected frontend lifecycle: a network failure/timeout
    // means the client never saw the first response, so it retries with
    // the *same* idempotencyKey rather than minting a new one. The server
    // must recognize this as the same attempt, not a new checkout.
    const request = buildRequest();
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');

    const first = await submitCheckout(
      checkoutService,
      request,
      undefined,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );
    // The "lost response" retry — identical request, identical key.
    const retryAfterSimulatedLostResponse = await submitCheckout(
      checkoutService,
      request,
      undefined,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );

    expect(retryAfterSimulatedLostResponse.orderId).toBe(first.orderId);
    expect(retryAfterSimulatedLostResponse.accessToken).toBe(first.accessToken);
    expect(chargeSpy).toHaveBeenCalledTimes(1);

    const attempts = await prisma.paymentAttempt.count({
      where: attemptsOfCheckout(request.clientRef),
    });
    expect(attempts).toBe(1);

    const orders = await prisma.order.count({
      where: { paymentAttempt: attemptsOfCheckout(request.clientRef) },
    });
    expect(orders).toBe(1);
  });

  it('a definitive decline ends that attempt: retrying the same checkout is ONE new attempt (ESP-03 PR 6), declined again here', async () => {
    const request = buildRequest({
      guest: {
        name: 'Decline Guest',
        phone: FakePaymentProvider.DECLINE_TEST_PHONE,
      },
    });

    await expect(
      submitCheckout(
        checkoutService,
        request,
        undefined,
        tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
      ),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      submitCheckout(
        checkoutService,
        request,
        undefined,
        tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
      ),
    ).rejects.toBeInstanceOf(HttpException);

    const attempts = await prisma.paymentAttempt.findMany({
      where: attemptsOfCheckout(request.clientRef),
    });
    expect(attempts.map((a) => a.status)).toEqual(['DECLINED', 'DECLINED']);
  });

  it('rejects concurrent duplicate submissions under the same idempotency key without double-charging', async () => {
    const request = buildRequest();

    const results = await Promise.allSettled([
      submitCheckout(
        checkoutService,
        request,
        undefined,
        tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
      ),
      submitCheckout(
        checkoutService,
        request,
        undefined,
        tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // One wins outright; the other either replays the same order or hits
    // the in-flight ConflictException — either way, never two orders.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ConflictException);
    }

    const orders = await prisma.order.count({
      where: { paymentAttempt: attemptsOfCheckout(request.clientRef) },
    });
    expect(orders).toBe(1);
  });

  it('marks reconciliation-required when payment succeeds but the order transaction fails; a retry creates the order from the saved checkout without charging again', async () => {
    const request = buildRequest();
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    // Deliberately force the protected post-payment transaction to fail —
    // simulates a DB error, a constraint violation, anything that aborts
    // the transaction after FakePaymentProvider has already succeeded.
    // ESP-03 PR 4 — the first transaction saves the payment attempt with
    // its checkout (before the charge); the order transaction is the next.
    const realTransaction = prisma.$transaction.bind(
      prisma,
    ) as typeof prisma.$transaction;
    jest
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(realTransaction)
      .mockRejectedValueOnce(new Error('Simulated Order transaction failure'));

    await expect(
      submitCheckout(
        checkoutService,
        request,
        undefined,
        tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
      ),
    ).rejects.toThrow('Simulated Order transaction failure');

    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
      where: attemptsOfCheckout(request.clientRef),
    });
    // The payment truthfully succeeded — this must never be relabeled
    // DECLINED/FAILED just because the order couldn't be created.
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.reconciliationRequired).toBe(true);
    expect(attempt.reconciliationReason).toContain(
      'Simulated Order transaction failure',
    );
    expect(attempt.reconciliationDetectedAt).not.toBeNull();

    const order = await prisma.order.findUnique({
      where: { paymentAttemptId: attempt.id },
    });
    expect(order).toBeNull();

    expect(chargeSpy).toHaveBeenCalledTimes(1);

    // ESP-03 PR 4 — retrying with the same key never charges again: the
    // missing order is created now from the checkout saved before payment.
    const resumed = await submitCheckout(
      checkoutService,
      request,
      undefined,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );
    expect(chargeSpy).toHaveBeenCalledTimes(1);
    const orders = await prisma.order.findMany({
      where: { paymentAttemptId: attempt.id },
    });
    expect(orders.map((o) => o.id)).toEqual([resumed.orderId]);
    expect(
      await prisma.paymentAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
      }),
    ).toMatchObject({
      status: 'SUCCEEDED',
      reconciliationRequired: false,
      fulfilmentStatus: 'DONE',
    });
  });

  it('exposes order status only to the holder of the correct access token', async () => {
    const request = buildRequest();
    const confirmation = await submitCheckout(
      checkoutService,
      request,
      undefined,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );

    const status = await checkoutService.getStatus(
      confirmation.orderId,
      confirmation.accessToken,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );
    expect(status.orderNumber).toBe(confirmation.orderNumber);

    await expect(
      checkoutService.getStatus(
        confirmation.orderId,
        'wrong-token',
        tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
      ),
    ).rejects.toThrow('Order not found.');
  });
});
