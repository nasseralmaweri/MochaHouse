import 'dotenv/config';
import { RefundReconciliationService } from '../orders/application/refund-reconciliation.service';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  createTestTenantB,
  removePaymentAccountsForTest,
  removePaymentRecoveryRecordsForTest,
  removeTestTenantB,
  TEST_TENANT_B_ID,
  tenantContextFor,
} from '@mocha-house/testing';
import type { CheckoutSubmitResult } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisModule } from '../redis/redis.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { LocationsModule } from '../locations/locations.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { CustomersModule } from '../customers/customers.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';
import { AuditModule } from '../audit/audit.module';
import { PaymentModule } from './payment.module';
import { PAYMENT_PROVIDER } from './payment-provider.token';
import { CheckoutService } from '../orders/application/checkout.service';
import { PaymentEventsService } from '../restaurant-payments/payment-events/payment-events.service';
import { PaymentEventsController } from '../restaurant-payments/payment-events/payment-events.controller';
import { PaymentAccountsService } from '../restaurant-payments/application/payment-accounts.service';
import {
  CONNECT_ACCOUNT_PROVIDER,
  DisabledConnectAccountProvider,
} from '../restaurant-payments/provider/connect-account-provider';
import {
  REDRIVE_GRACE_MS,
  REDRIVE_MAX_ATTEMPTS,
  paymentEventRedriveEnabled,
} from '../restaurant-payments/payment-events/payment-events.service';
import {
  fakeStripePayments,
  signedPaymentEvent,
  stripeError,
  testOnly,
} from '../../test/fake-stripe-intents';
import {
  attemptsOfCheckout,
  checkoutAttemptsOfThisSuite,
  checkoutSessionsOfThisSuite,
  checkoutTokenFor,
  type LabelledCheckoutRequest,
} from '../../test/checkout-session';

// ESP-04 M3 — Stripe PaymentIntents checkout and payment webhooks against a
// real disposable database, with real services and the REAL Stripe adapter
// whose SDK intent calls are an in-memory stand-in (no network, no Stripe
// account; signatures by the SDK's own helpers). Covers:
//   * D1 — the readiness gate: only an allowlisted business whose connected
//     account is READY may start a payment, refused before anything exists;
//   * a direct charge on the business's own account, the account recorded on
//     the payment, and the browser told the publishable key and account;
//   * a NEW intent is not a refused one; a refusal is retried on the same
//     intent; processing that later fails waits for its customer again;
//   * safeguard 1 — no Stripe error at creation releases anything;
//   * D6/D7 — webhooks settle the payment only from Stripe's own answer, the
//     order exactly once across deliveries, checks and races; safeguard 2 —
//     an unfinished event is never acknowledged, a recorded but unfinished
//     event is processed again (never skipped because its id exists), and
//     the re-drive (off by default) finishes it when enabled;
//   * linking only through OUR account and intent records: other businesses'
//     accounts, unknown intents and metadata claims never link a payment;
//   * the M1 account-events handler never touches a payment event.

jest.setTimeout(240_000);

const T1 = TENANT_1_MOCHA_HOUSE_ID;

async function outcomeOf<T>(fn: () => Promise<T>): Promise<{
  ok: boolean;
  value?: T;
  status?: number;
}> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return {
      ok: false,
      status: (e as { getStatus?: () => number }).getStatus?.(),
    };
  }
}

describe('ESP-04 M3 Stripe payments (integration, offline Stripe)', () => {
  const allowed = new Set<string>([T1]);
  const { stripe, intents, provider } = fakeStripePayments(allowed);
  const t1 = tenantContextFor(T1);
  const run = randomUUID().slice(0, 8);
  const ACCT_1 = `acct_1M3a${run}`;
  const ACCT_B = `acct_1M3b${run}`;
  let moduleRef: TestingModule;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let checkout: CheckoutService;
  let events: PaymentEventsService;
  let accounts: PaymentAccountsService;
  let locationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;
  const userIds: string[] = [];
  const promotions: string[] = [];
  const eventIds: string[] = [];
  const originalEnv = { ...process.env };

  const evt = () => {
    const id = `evt_M3${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    eventIds.push(id);
    return id;
  };

  async function staff(tenantId: string): Promise<string> {
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:m3-${tenantId.slice(-4)}-${run}`,
        email: `m3-${tenantId.slice(-4)}-${run}@example.test`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function readyAccount(tenantId: string, accountId: string) {
    await prisma.tenantPaymentAccount.create({
      data: {
        tenantId,
        provider: 'stripe',
        livemode: false,
        externalAccountId: accountId,
        dashboard: 'full',
        feesCollector: 'stripe',
        lossesCollector: 'stripe',
        cardPaymentsStatus: 'active',
        requirementsDue: 0,
        lastSyncedAt: new Date(),
        connectedByInternalUserId: await staff(tenantId),
      },
    });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.RESTAURANT_PAYMENT_EVENT_REDRIVE_ENABLED;
    moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        RedisModule,
        RateLimitModule,
        LocationsModule,
        CustomerAuthModule,
        InternalAuthModule,
        CustomersModule,
        LoyaltyModule,
        PromotionsModule,
        GiftCardsModule,
        AuditModule,
        PaymentModule,
      ],
      controllers: [PaymentEventsController],
      providers: [
        CheckoutService,
        RefundReconciliationService,
        PaymentEventsService,
        PaymentAccountsService,
        {
          provide: CONNECT_ACCOUNT_PROVIDER,
          useValue: new DisabledConnectAccountProvider(),
        },
      ],
    })
      .overrideProvider(PAYMENT_PROVIDER)
      .useFactory({ factory: () => provider })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    prisma = moduleRef.get(PrismaService);
    checkout = moduleRef.get(CheckoutService);
    events = moduleRef.get(PaymentEventsService);
    accounts = moduleRef.get(PaymentAccountsService);

    const location = await prisma.location.findUniqueOrThrow({
      where: { tenantId_slug: { tenantId: T1, slug: 'dearborn-heights' } },
    });
    const product = await prisma.product.findUniqueOrThrow({
      where: { tenantId_slug: { tenantId: T1, slug: 'drip-coffee' } },
      include: {
        modifierGroups: {
          include: { modifierGroup: { include: { options: true } } },
        },
      },
    });
    locationId = location.id;
    productId = product.id;
    const group = product.modifierGroups[0].modifierGroup;
    sizeGroupId = group.id;
    mediumOptionId = group.options.find((o) => o.name === 'Medium')!.id;

    await createTestTenantB(prisma);
    // Earlier suites may have left an account for tenant 1.
    await removePaymentAccountsForTest({ tenantIds: [T1, TEST_TENANT_B_ID] });
    await readyAccount(T1, ACCT_1);
    await readyAccount(TEST_TENANT_B_ID, ACCT_B);
  });

  afterAll(async () => {
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
    await prisma.orderPromotionRedemption.deleteMany({
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
    await prisma.promotionCustomerUsage.deleteMany({
      where: { promotionId: { in: promotions } },
    });
    await prisma.promotion.deleteMany({ where: { id: { in: promotions } } });
    await removePaymentAccountsForTest({
      tenantIds: [T1, TEST_TENANT_B_ID],
      externalAccountIds: [ACCT_1, ACCT_B],
      externalEventIds: eventIds,
    });
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await removeTestTenantB(prisma);
    await app.close();
    process.env = { ...originalEnv };
  });

  beforeEach(() => {
    allowed.clear();
    allowed.add(T1);
    intents.createError = null;
    intents.retrieveError = null;
    intents.createAmountOverride = null;
    intents.create.mockClear();
    intents.retrieve.mockClear();
  });

  // --- fixtures ------------------------------------------------------------------

  const body = (
    overrides: Partial<LabelledCheckoutRequest> = {},
  ): LabelledCheckoutRequest => ({
    clientRef: `m3_${randomUUID()}`,
    locationId,
    guest: { name: 'Stripe Guest', phone: '5551238888' },
    lines: [
      {
        productId,
        quantity: 2,
        selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
      },
    ],
    ...overrides,
  });

  const tokenOf = (r: LabelledCheckoutRequest) =>
    checkoutTokenFor(checkout, r.clientRef, locationId, undefined, t1);

  async function submit(
    r: LabelledCheckoutRequest,
  ): Promise<CheckoutSubmitResult> {
    const checkoutToken = await tokenOf(r);
    return checkout.submit(
      {
        locationId: r.locationId,
        guest: r.guest,
        lines: r.lines,
        couponCode: r.couponCode,
        checkoutToken,
      },
      undefined,
      t1,
    );
  }

  async function check(
    r: LabelledCheckoutRequest,
  ): Promise<CheckoutSubmitResult> {
    return checkout.checkPayment(
      { locationId, checkoutToken: await tokenOf(r) },
      undefined,
      t1,
    );
  }

  const attemptsOf = (r: LabelledCheckoutRequest) =>
    prisma.paymentAttempt.findMany({
      where: attemptsOfCheckout(r.clientRef),
      orderBy: { createdAt: 'asc' },
    });
  const attemptOf = async (r: LabelledCheckoutRequest) => {
    const all = await attemptsOf(r);
    expect(all).toHaveLength(1);
    return all[0];
  };
  const ordersOf = async (r: LabelledCheckoutRequest) =>
    prisma.order.findMany({
      where: {
        paymentAttemptId: { in: (await attemptsOf(r)).map((a) => a.id) },
      },
    });
  const holdsOf = async (r: LabelledCheckoutRequest, status: string) =>
    prisma.financialHold.count({
      where: {
        paymentAttemptId: { in: (await attemptsOf(r)).map((a) => a.id) },
        status: status as 'ACTIVE',
      },
    });
  const caseOf = async (r: LabelledCheckoutRequest) =>
    prisma.paymentReconciliationCase.findFirst({
      where: { paymentAttemptId: (await attemptOf(r)).id },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });

  async function coupon(): Promise<string> {
    const code = `M3${randomUUID().slice(0, 8)}`.toUpperCase();
    const promotion = await prisma.promotion.create({
      data: {
        tenantId: T1,
        name: `M3 coupon ${code}`,
        kind: 'COUPON',
        code,
        discountType: 'FIXED_AMOUNT',
        discountValue: 50,
        appliesToAllLocations: true,
        totalRedemptionLimit: null,
      },
    });
    promotions.push(promotion.id);
    return code;
  }

  function paymentOf(result: CheckoutSubmitResult) {
    if (result.outcome !== 'PAYMENT_REQUIRED') {
      throw new Error(`expected PAYMENT_REQUIRED, got ${result.outcome}`);
    }
    return result.payment;
  }

  async function deliver(
    type: string,
    reference: string | null,
    options: {
      account?: string | null;
      id?: string;
      metadata?: Record<string, string>;
      livemode?: boolean;
    } = {},
  ): Promise<boolean> {
    const verified = provider.verifyPaymentEvent(
      signedPaymentEvent(stripe, {
        id: options.id ?? evt(),
        type,
        account: options.account === undefined ? ACCT_1 : options.account,
        intent: reference
          ? {
              id: reference,
              metadata: options.metadata ?? {
                centerivo_payment_attempt_id: 'x',
              },
            }
          : null,
        livemode: options.livemode,
      }),
    );
    return events.handle(verified);
  }

  const eventRow = (id: string) =>
    prisma.restaurantPaymentProviderEvent.findUnique({
      where: {
        provider_externalEventId: { provider: 'stripe', externalEventId: id },
      },
    });

  // --- D1: who may start a payment ----------------------------------------------

  it('refuses a business that is not on the test-mode allowlist, before anything exists', async () => {
    allowed.clear();
    const r = body();
    expect(await outcomeOf(() => submit(r))).toMatchObject({
      ok: false,
      status: 503,
    });
    expect(await attemptsOf(r)).toHaveLength(0);
    expect(intents.create).not.toHaveBeenCalled();
  });

  it.each([
    ['card payments not active', { cardPaymentsStatus: 'pending' }],
    ['past-due requirements', { requirementsStatus: 'past_due' }],
    ['another configuration', { feesCollector: 'application' }],
    ['closed', { closed: true }],
    ['never read back', { lastSyncedAt: null }],
  ])(
    'refuses an account that is not READY (%s), before anything exists',
    async (_l, change) => {
      await prisma.tenantPaymentAccount.update({
        where: { tenantId: T1 },
        data: change,
      });
      try {
        const r = body();
        expect(await outcomeOf(() => submit(r))).toMatchObject({
          ok: false,
          status: 503,
        });
        expect(await attemptsOf(r)).toHaveLength(0);
        expect(intents.create).not.toHaveBeenCalled();
      } finally {
        await prisma.tenantPaymentAccount.update({
          where: { tenantId: T1 },
          data: {
            cardPaymentsStatus: 'active',
            requirementsStatus: null,
            feesCollector: 'stripe',
            closed: false,
            lastSyncedAt: new Date(),
          },
        });
      }
    },
  );

  // --- creation -----------------------------------------------------------------

  it("creates ONE direct charge on the business's own account and tells the browser how to confirm it", async () => {
    const r = body();
    const payment = paymentOf(await submit(r));
    const attempt = await attemptOf(r);
    const reference = attempt.providerReference!;
    expect(attempt).toMatchObject({
      provider: 'stripe',
      status: 'PENDING',
      paymentState: 'REQUIRES_CUSTOMER_ACTION',
      providerAccountId: ACCT_1,
    });
    expect(payment).toEqual({
      provider: 'stripe',
      // A NEW intent waits for its card: not a refused payment.
      state: 'REQUIRES_CUSTOMER_ACTION',
      clientSecret: `${reference}_secret_TESTONLY`,
      publishableKey: testOnly('pk_test'),
      connectedAccountId: ACCT_1,
      amountMinorUnits: attempt.amount,
      currency: 'USD',
    });
    expect(intents.create).toHaveBeenCalledTimes(1);
    const [params, options] = intents.create.mock.calls[0];
    expect(options).toEqual({
      stripeAccount: ACCT_1,
      idempotencyKey: attempt.idempotencyKey,
    });
    expect(params).toMatchObject({
      amount: attempt.amount,
      currency: 'usd',
      payment_method_types: ['card'],
      metadata: {
        centerivo_payment_attempt_id: attempt.id,
        centerivo_tenant_id: T1,
      },
    });
    expect(JSON.stringify(params)).not.toContain('5551238888');

    // A retry and a check resume the SAME intent (no second creation).
    paymentOf(await submit(r));
    expect(paymentOf(await check(r)).state).toBe('REQUIRES_CUSTOMER_ACTION');
    expect(intents.create).toHaveBeenCalledTimes(1);
    expect(await attemptsOf(r)).toHaveLength(1);
    expect(await ordersOf(r)).toHaveLength(0);
  });

  // Safeguard 1.
  it.each([
    [
      'a 400 invalid request',
      stripeError('StripeInvalidRequestError', 'amount_too_small', 400),
    ],
    ['a 401', stripeError('StripeAuthenticationError', undefined, 401)],
    ['a 403', stripeError('StripePermissionError', undefined, 403)],
    [
      'an idempotency conflict',
      stripeError('StripeIdempotencyError', 'idempotency_error', 400),
    ],
    ['a 500', stripeError('StripeAPIError', undefined, 500)],
    ['a connection error', stripeError('StripeConnectionError')],
  ])(
    '%s at creation is held as UNKNOWN with a case: holds kept, never released',
    async (_l, error) => {
      const r = body({ couponCode: await coupon() });
      intents.createError = error;
      expect(await outcomeOf(() => submit(r))).toMatchObject({
        ok: false,
        status: 409,
      });
      const attempt = await attemptOf(r);
      expect(attempt).toMatchObject({
        status: 'PENDING',
        paymentState: 'UNKNOWN',
        providerReference: null,
      });
      expect(attempt.failureReason).toMatch(/^stripe_create:/);
      expect(await holdsOf(r, 'ACTIVE')).toBe(1);
      expect(await holdsOf(r, 'RELEASED')).toBe(0);
      expect(await caseOf(r)).toMatchObject({
        status: 'OPEN',
        reasonCode: 'PROVIDER_OUTCOME_UNKNOWN',
      });
      // Never retried, never a new intent.
      expect(await outcomeOf(() => submit(r))).toMatchObject({ status: 409 });
      expect(await attemptsOf(r)).toHaveLength(1);
    },
  );

  // --- the outcome comes from Stripe ---------------------------------------------

  it('a paid intent becomes ONE order through the webhook, whatever the deliveries and checks', async () => {
    const r = body({ couponCode: await coupon() });
    paymentOf(await submit(r));
    const reference = (await attemptOf(r)).providerReference!;

    // A delivery before the customer paid changes nothing (the body's
    // "succeeded" status is never trusted).
    expect(await deliver('payment_intent.requires_action', reference)).toBe(
      true,
    );
    expect((await attemptOf(r)).paymentState).toBe('REQUIRES_CUSTOMER_ACTION');

    intents.succeed(reference);
    const id = evt();
    expect(await deliver('payment_intent.succeeded', reference, { id })).toBe(
      true,
    );
    expect(await attemptOf(r)).toMatchObject({
      status: 'SUCCEEDED',
      paymentState: 'SUCCEEDED',
    });
    expect(await ordersOf(r)).toHaveLength(1);
    expect(await holdsOf(r, 'CONSUMED')).toBe(1);
    expect(await eventRow(id)).toMatchObject({
      status: 'PROCESSED',
      outcome: 'PAYMENT_RECONCILED',
      externalAccountId: ACCT_1,
      externalObjectId: reference,
    });

    // Redelivered, a second event for the same intent, the browser's check
    // and a retried submit: still the same single order.
    expect(await deliver('payment_intent.succeeded', reference, { id })).toBe(
      true,
    );
    expect(await deliver('payment_intent.succeeded', reference)).toBe(true);
    const checked = await check(r);
    expect(checked.outcome).toBe('COMPLETED');
    expect((await submit(r)).outcome).toBe('COMPLETED');
    expect(await ordersOf(r)).toHaveLength(1);
    expect(await holdsOf(r, 'CONSUMED')).toBe(1);
  });

  it('a webhook and a browser check racing on a paid intent make exactly one order', async () => {
    const r = body({ couponCode: await coupon() });
    paymentOf(await submit(r));
    const reference = (await attemptOf(r)).providerReference!;
    intents.succeed(reference);
    const results = await Promise.all([
      deliver('payment_intent.succeeded', reference),
      deliver('payment_intent.succeeded', reference),
      outcomeOf(() => check(r)),
      outcomeOf(() => check(r)),
    ]);
    expect(results[0]).toBe(true);
    expect(results[1]).toBe(true);
    expect(await ordersOf(r)).toHaveLength(1);
    expect(await holdsOf(r, 'CONSUMED')).toBe(1);
  });

  it('a refused card waits on the SAME intent with holds kept', async () => {
    const r = body({ couponCode: await coupon() });
    paymentOf(await submit(r));
    const reference = (await attemptOf(r)).providerReference!;
    intents.decline(reference);
    expect(await deliver('payment_intent.payment_failed', reference)).toBe(
      true,
    );
    expect(paymentOf(await check(r)).state).toBe('REQUIRES_PAYMENT_METHOD');
    expect(await attemptOf(r)).toMatchObject({
      status: 'PENDING',
      paymentState: 'REQUIRES_CUSTOMER_ACTION',
      providerReference: reference,
    });
    expect(await holdsOf(r, 'ACTIVE')).toBe(1);
    // ...then paid on the same intent.
    intents.succeed(reference);
    expect((await check(r)).outcome).toBe('COMPLETED');
    expect(intents.create).toHaveBeenCalledTimes(1);
  });

  it('processing is held with a case; a later refusal waits for its customer again (and says so on the case)', async () => {
    const r = body({ couponCode: await coupon() });
    paymentOf(await submit(r));
    const reference = (await attemptOf(r)).providerReference!;
    intents.process(reference);
    expect(await deliver('payment_intent.processing', reference)).toBe(true);
    expect((await attemptOf(r)).paymentState).toBe('AWAITING_CONFIRMATION');
    expect(await caseOf(r)).toMatchObject({
      reasonCode: 'PROVIDER_AWAITING_CONFIRMATION',
    });
    expect(await holdsOf(r, 'ACTIVE')).toBe(1);

    intents.decline(reference);
    expect(await deliver('payment_intent.payment_failed', reference)).toBe(
      true,
    );
    expect(await attemptOf(r)).toMatchObject({
      status: 'PENDING',
      paymentState: 'REQUIRES_CUSTOMER_ACTION',
    });
    const kase = await caseOf(r);
    expect(kase!.events.map((e) => e.action)).toContain(
      'PROVIDER_REQUIRES_PAYMENT_METHOD',
    );
    expect(await holdsOf(r, 'ACTIVE')).toBe(1);
    expect(paymentOf(await check(r)).state).toBe('REQUIRES_PAYMENT_METHOD');
  });

  it('a cancelled intent closes the payment and releases its holds (nothing can be charged)', async () => {
    const r = body({ couponCode: await coupon() });
    paymentOf(await submit(r));
    const reference = (await attemptOf(r)).providerReference!;
    intents.cancel(reference);
    expect(await deliver('payment_intent.canceled', reference)).toBe(true);
    const attempt = await attemptOf(r);
    expect(attempt).toMatchObject({ status: 'FAILED', paymentState: 'FAILED' });
    expect(attempt.fulfilmentStatus).toBe('NOT_REQUIRED');
    expect(await holdsOf(r, 'RELEASED')).toBe(1);
    expect(
      await prisma.checkoutSnapshot.count({
        where: { paymentAttemptId: attempt.id },
      }),
    ).toBe(0);
    expect(await ordersOf(r)).toHaveLength(0);
  });

  it('a different amount taken is never paid nor released: held for people, the event finished', async () => {
    const r = body({ couponCode: await coupon() });
    paymentOf(await submit(r));
    const attempt = await attemptOf(r);
    intents.succeed(attempt.providerReference!, attempt.amount - 1);
    const id = evt();
    expect(
      await deliver('payment_intent.succeeded', attempt.providerReference, {
        id,
      }),
    ).toBe(true);
    expect(await attemptOf(r)).toMatchObject({ status: 'PENDING' });
    expect(await caseOf(r)).toMatchObject({
      reasonCode: 'PROVIDER_AMOUNT_MISMATCH',
    });
    expect(await holdsOf(r, 'ACTIVE')).toBe(1);
    expect(await ordersOf(r)).toHaveLength(0);
    expect((await eventRow(id))!.status).toBe('PROCESSED');
  });

  // --- safeguard 2: crash-safe acknowledgement -----------------------------------

  it('an event whose payment cannot be read yet is NOT acknowledged; a redelivery finishes it', async () => {
    const r = body();
    paymentOf(await submit(r));
    const reference = (await attemptOf(r)).providerReference!;
    intents.succeed(reference);
    intents.retrieveError = stripeError('StripeAPIError', undefined, 500);
    const id = evt();
    expect(await deliver('payment_intent.succeeded', reference, { id })).toBe(
      false,
    );
    expect(await eventRow(id)).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(await ordersOf(r)).toHaveLength(0);
    expect((await attemptOf(r)).status).toBe('PENDING');
    // Money may have moved: visible to people without waiting for Stripe.
    expect(await caseOf(r)).toMatchObject({
      status: 'OPEN',
      reasonCode: 'PROVIDER_EVENT_NOT_SETTLED',
    });

    expect(await deliver('payment_intent.succeeded', reference, { id })).toBe(
      true,
    );
    expect(await eventRow(id)).toMatchObject({
      status: 'PROCESSED',
      attempts: 2,
    });
    expect(await ordersOf(r)).toHaveLength(1);
    // ...and resolved with the order.
    expect(await caseOf(r)).toMatchObject({
      status: 'RESOLVED',
      resolution: 'FULFILLED',
    });
  });

  it('a recorded event left unfinished by a crash is processed again, never skipped because its id exists', async () => {
    const r = body();
    paymentOf(await submit(r));
    const reference = (await attemptOf(r)).providerReference!;
    intents.succeed(reference);
    const id = evt();
    // The process recorded the event, then stopped before finishing it.
    await prisma.restaurantPaymentProviderEvent.create({
      data: {
        provider: 'stripe',
        externalEventId: id,
        type: 'payment_intent.succeeded',
        livemode: false,
        externalAccountId: ACCT_1,
        externalObjectId: reference,
        payloadDigest: '0'.repeat(64),
      },
    });
    expect(await deliver('payment_intent.succeeded', reference, { id })).toBe(
      true,
    );
    expect((await eventRow(id))!.status).toBe('PROCESSED');
    expect(await ordersOf(r)).toHaveLength(1);
  });

  it('concurrent deliveries of one event are both acknowledged only once it is finished, with one order', async () => {
    const r = body();
    paymentOf(await submit(r));
    const reference = (await attemptOf(r)).providerReference!;
    intents.succeed(reference);
    const id = evt();
    const both = await Promise.all([
      deliver('payment_intent.succeeded', reference, { id }),
      deliver('payment_intent.succeeded', reference, { id }),
      deliver('payment_intent.succeeded', reference, { id }),
    ]);
    expect(both).toEqual([true, true, true]);
    expect((await eventRow(id))!.status).toBe('PROCESSED');
    expect(await ordersOf(r)).toHaveLength(1);
  });

  it('the re-drive is OFF by default; enabled, it finishes unfinished events with backoff and a cap', async () => {
    expect(paymentEventRedriveEnabled({})).toBe(false);
    expect(
      paymentEventRedriveEnabled({
        RESTAURANT_PAYMENT_EVENT_REDRIVE_ENABLED: '0',
      }),
    ).toBe(false);
    expect(
      paymentEventRedriveEnabled({
        RESTAURANT_PAYMENT_EVENT_REDRIVE_ENABLED: '1',
      }),
    ).toBe(true);

    const r = body();
    paymentOf(await submit(r));
    const reference = (await attemptOf(r)).providerReference!;
    intents.succeed(reference);
    intents.retrieveError = stripeError('StripeConnectionError');
    const id = evt();
    expect(await deliver('payment_intent.succeeded', reference, { id })).toBe(
      false,
    );
    const failed = (await eventRow(id))!;
    expect(failed.status).toBe('FAILED');

    // Too recent (grace, then backoff): not re-driven yet.
    await events.redrive(new Date(failed.receivedAt.getTime() + 1_000));
    expect((await eventRow(id))!.status).toBe('FAILED');

    // Past the grace and the backoff: finished from what was stored.
    const later = new Date(
      failed.receivedAt.getTime() + REDRIVE_GRACE_MS + 60 * 60_000,
    );
    await events.redrive(later);
    expect(await eventRow(id)).toMatchObject({
      status: 'PROCESSED',
      attempts: 2,
    });
    expect(await ordersOf(r)).toHaveLength(1);

    // An event that reached the cap is left for people (and for Stripe's
    // own redeliveries), never acknowledged.
    const capped = evt();
    await prisma.restaurantPaymentProviderEvent.create({
      data: {
        provider: 'stripe',
        externalEventId: capped,
        type: 'payment_intent.succeeded',
        livemode: false,
        externalAccountId: ACCT_1,
        externalObjectId: reference,
        payloadDigest: '0'.repeat(64),
        status: 'FAILED',
        attempts: REDRIVE_MAX_ATTEMPTS,
        receivedAt: new Date(Date.now() - 24 * 60 * 60_000),
      },
    });
    await events.redrive(later);
    expect((await eventRow(capped))!.status).toBe('FAILED');
  });

  // --- linking only through our own records --------------------------------------

  it("never links a payment through another business's account, even naming its intent", async () => {
    const r = body();
    paymentOf(await submit(r));
    const reference = (await attemptOf(r)).providerReference!;
    intents.succeed(reference);
    const id = evt();
    expect(
      await deliver('payment_intent.succeeded', reference, {
        id,
        account: ACCT_B,
      }),
    ).toBe(true);
    expect(await eventRow(id)).toMatchObject({
      status: 'UNMATCHED',
      outcome: 'NO_MATCHING_PAYMENT',
    });
    expect((await attemptOf(r)).status).toBe('PENDING');
    expect(await ordersOf(r)).toHaveLength(0);
  });

  it('keeps a verified event for a known business that names no payment of it, linking nothing (metadata is never trusted)', async () => {
    const r = body();
    paymentOf(await submit(r));
    const attempt = await attemptOf(r);
    const id = evt();
    // Claims, through metadata, to be this very payment — on an intent that
    // is not the one we recorded.
    expect(
      await deliver('payment_intent.succeeded', 'pi_SomeoneElse1', {
        id,
        metadata: {
          centerivo_payment_attempt_id: attempt.id,
          centerivo_tenant_id: T1,
        },
      }),
    ).toBe(true);
    expect(await eventRow(id)).toMatchObject({
      status: 'UNMATCHED',
      externalAccountId: ACCT_1,
      externalObjectId: 'pi_SomeoneElse1',
    });
    expect(await attemptOf(r)).toMatchObject({
      status: 'PENDING',
      paymentState: 'REQUIRES_CUSTOMER_ACTION',
      providerReference: attempt.providerReference,
    });
  });

  it("acknowledges a restaurant's own Stripe traffic without keeping it, and ignores unknown accounts and live mode", async () => {
    const theirs = evt();
    expect(
      await deliver('payment_intent.succeeded', 'pi_TheirOwnSale1', {
        id: theirs,
        metadata: {},
      }),
    ).toBe(true);
    expect(await eventRow(theirs)).toBeNull();

    const unknown = evt();
    expect(
      await deliver('payment_intent.succeeded', 'pi_Whatever1', {
        id: unknown,
        account: 'acct_1NotOurs',
      }),
    ).toBe(true);
    expect(await eventRow(unknown)).toMatchObject({
      status: 'IGNORED',
      outcome: 'UNKNOWN_ACCOUNT',
    });

    const live = evt();
    expect(
      await deliver('payment_intent.succeeded', 'pi_Live1', {
        id: live,
        livemode: true,
      }),
    ).toBe(true);
    expect(await eventRow(live)).toMatchObject({
      status: 'IGNORED',
      outcome: 'LIVE_MODE_REFUSED',
    });

    // Not a payment event: acknowledged, never recorded here.
    const other = evt();
    expect(
      await deliver('charge.refunded', 'pi_Whatever2', { id: other }),
    ).toBe(true);
    expect(await eventRow(other)).toBeNull();
  });

  it('the M1 account-events handler never touches a payment event (same table)', async () => {
    const id = evt();
    await prisma.restaurantPaymentProviderEvent.create({
      data: {
        provider: 'stripe',
        externalEventId: id,
        type: 'payment_intent.succeeded',
        livemode: false,
        externalAccountId: ACCT_1,
        externalObjectId: 'pi_Untouched1',
        payloadDigest: '0'.repeat(64),
      },
    });
    expect(
      await accounts.handleEvent({
        provider: 'stripe',
        externalEventId: id,
        type: 'payment_intent.succeeded',
        livemode: false,
        externalAccountId: ACCT_1,
        payloadDigest: '0'.repeat(64),
      }),
    ).toBe(true);
    expect(await eventRow(id)).toMatchObject({
      status: 'RECEIVED',
      attempts: 0,
    });
  });

  it('the database keeps one Stripe payment per intent and never changes its account or intent', async () => {
    const r = body();
    paymentOf(await submit(r));
    const attempt = await attemptOf(r);
    await expect(
      prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { providerAccountId: ACCT_B },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { providerReference: 'pi_Swapped1' },
      }),
    ).rejects.toThrow();
    // A second Stripe payment naming the same intent is refused.
    const duplicateKey = `ck_m3-duplicate-${run}`;
    await expect(
      prisma.$executeRaw`INSERT INTO "PaymentAttempt" (id, "tenantId", "idempotencyKey", provider, amount, currency, status, "paymentState", "providerReference", "providerAccountId", "updatedAt")
        VALUES (${randomUUID()}, ${T1}, ${duplicateKey}, 'stripe', 100, 'USD', 'PENDING'::"PaymentAttemptStatus", 'REQUIRES_CUSTOMER_ACTION', ${attempt.providerReference}, ${ACCT_1}, now())`,
    ).rejects.toThrow();
    // A Stripe payment naming an intent always names its account.
    await expect(
      prisma.$executeRaw`INSERT INTO "PaymentAttempt" (id, "tenantId", "idempotencyKey", provider, amount, currency, status, "paymentState", "providerReference", "updatedAt")
        VALUES (${randomUUID()}, ${T1}, ${`${duplicateKey}-2`}, 'stripe', 100, 'USD', 'PENDING'::"PaymentAttemptStatus", 'REQUIRES_CUSTOMER_ACTION', 'pi_NoAccount1', now())`,
    ).rejects.toThrow();
    expect((await attemptOf(r)).providerAccountId).toBe(ACCT_1);
  });

  // --- the HTTP endpoint ---------------------------------------------------------

  it('the endpoint verifies the raw body: 400 unsigned or forged, 200 handled, 503 unfinished', async () => {
    const server = app.getHttpServer();
    const path = '/api/v1/restaurant-payments/webhooks/stripe/payments';
    await request(server)
      .post(path)
      .set('Content-Type', 'application/json')
      .send('{"id":"evt_x"}')
      .expect(400);
    const forged = signedPaymentEvent(
      stripe,
      {
        id: evt(),
        type: 'payment_intent.succeeded',
        account: ACCT_1,
        intent: { id: 'pi_1' },
      },
      'test-only-other-signing-key-not-a-stripe-secret',
    );
    await request(server)
      .post(path)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', forged.signatureHeader)
      .send(forged.rawBody.toString())
      .expect(400);

    const r = body();
    paymentOf(await submit(r));
    const reference = (await attemptOf(r)).providerReference!;
    intents.succeed(reference);
    const id = evt();
    const signed = signedPaymentEvent(stripe, {
      id,
      type: 'payment_intent.succeeded',
      account: ACCT_1,
      intent: {
        id: reference,
        metadata: { centerivo_payment_attempt_id: 'x' },
      },
    });
    intents.retrieveError = stripeError('StripeAPIError', undefined, 500);
    await request(server)
      .post(path)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signed.signatureHeader)
      .send(signed.rawBody.toString())
      .expect(503);
    await request(server)
      .post(path)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signed.signatureHeader)
      .send(signed.rawBody.toString())
      .expect(200);
    expect(await ordersOf(r)).toHaveLength(1);
  });
});
