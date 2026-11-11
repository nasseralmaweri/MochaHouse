import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  createTestTenantB,
  removePaymentAccountsForTest,
  removePaymentRecoveryRecordsForTest,
  removeTestTenantB,
  TEST_TENANT_B_ID,
  tenantContextFor,
} from '@mocha-house/testing';
import type Stripe from 'stripe';
import type { CheckoutSubmitResult } from '@mocha-house/contracts';
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
import { PAYMENT_PROVIDER } from '../payment/payment-provider.token';
import { CheckoutService } from '../orders/application/checkout.service';
import { OrdersController } from '../orders/api/orders.controller';
import { RATE_LIMIT_POLICY_KEY } from '../rate-limit/rate-limit.decorator';
import type { CustomerIdentity } from '../customer-auth/infrastructure/customer-identity';
import { PaymentEventsService } from '../restaurant-payments/payment-events/payment-events.service';
import {
  abandonAfterMinutes,
  abandonedIntentCancelEnabled,
  MAX_AUTOMATIC_ATTEMPTS,
  PaymentRecoveryConfigurationError,
  PaymentRecoveryService,
} from './application/payment-recovery.service';
import { PlatformPaymentCasesService } from './application/platform-payment-cases.service';
import {
  fakeStripePayments,
  signedPaymentEvent,
  stripeError,
} from '../../test/fake-stripe-intents';
import {
  attemptsOfCheckout,
  checkoutAttemptsOfThisSuite,
  checkoutSessionsOfThisSuite,
  checkoutTokenFor,
  type LabelledCheckoutRequest,
} from '../../test/checkout-session';

// ESP-04 M4b — abandoned Stripe payment cleanup, against a real disposable
// database with real services and the real Stripe adapter over an in-memory
// PaymentIntents stand-in (no network, no Stripe account). Covers:
//   * the payment page's heartbeat: bound to the checkout session (business,
//     location, customer or guest), recorded only on the session's live
//     Stripe payment waiting for its customer, at most once a minute, with
//     nothing returned and the checkout rate limit;
//   * what counts as abandoned (the later of creation and the last verified
//     activity, past the deadline: 120 minutes by default, 30–1440), and the
//     switches (OFF by default; inside the automatic sweeper);
//   * cancelling ONLY a provably unpaid requires_payment_method intent on its
//     own account, then ALWAYS reading it back — holds released only when
//     Stripe confirms it cancelled with nothing received;
//   * never cancelling an authentication (held, case STRIPE_AUTHENTICATION_
//     STALE), a processing or paid intent, a pending or succeeded latest
//     charge, money received or another amount;
//   * a lost or failed cancel answer, a read-back failure, a late webhook, a
//     payment or a heartbeat racing the cancel, concurrent workers, and no
//     second cancellation or order.

jest.setTimeout(300_000);

const T1 = TENANT_1_MOCHA_HOUSE_ID;
const MIN = 60_000;
const later = (ms: number) => new Date(Date.now() + ms);

async function outcomeOf<T>(
  fn: () => Promise<T>,
): Promise<{ ok: boolean; status?: number }> {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      status: (e as { getStatus?: () => number }).getStatus?.(),
    };
  }
}

describe('ESP-04 M4b abandoned Stripe payment cleanup (integration, offline Stripe)', () => {
  const allowed = new Set<string>([T1]);
  const { stripe, intents, provider } = fakeStripePayments(allowed);
  const t1 = tenantContextFor(T1);
  const run = randomUUID().slice(0, 8);
  const ACCT_1 = `acct_1M4bA${run}`;
  const ACCT_B = `acct_1M4bB${run}`;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let checkout: CheckoutService;
  let events: PaymentEventsService;
  let recovery: PaymentRecoveryService;
  let cases: PlatformPaymentCasesService;
  let locationId: string;
  let otherLocationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;
  const userIds: string[] = [];
  const promotions: string[] = [];
  const eventIds: string[] = [];
  const originalEnv = { ...process.env };

  const evt = () => {
    const id = `evt_M4b${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    eventIds.push(id);
    return id;
  };

  async function readyAccount(tenantId: string, accountId: string) {
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:m4b-${tenantId.slice(-4)}-${run}`,
        email: `m4b-${tenantId.slice(-4)}-${run}@example.test`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(user.id);
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
        connectedByInternalUserId: user.id,
      },
    });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.PAYMENT_AUTO_RECOVERY_ENABLED;
    delete process.env.PAYMENT_ABANDONED_INTENT_CANCEL_ENABLED;
    delete process.env.PAYMENT_ABANDON_AFTER_MINUTES;
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
      providers: [
        CheckoutService,
        PaymentEventsService,
        PaymentRecoveryService,
        PlatformPaymentCasesService,
      ],
    })
      .overrideProvider(PAYMENT_PROVIDER)
      .useFactory({ factory: () => provider })
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    checkout = moduleRef.get(CheckoutService);
    events = moduleRef.get(PaymentEventsService);
    recovery = moduleRef.get(PaymentRecoveryService);
    cases = moduleRef.get(PlatformPaymentCasesService);

    const location = await prisma.location.findUniqueOrThrow({
      where: { tenantId_slug: { tenantId: T1, slug: 'dearborn-heights' } },
    });
    const other = await prisma.location.findFirstOrThrow({
      where: { tenantId: T1, id: { not: location.id } },
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
    otherLocationId = other.id;
    productId = product.id;
    const group = product.modifierGroups[0].modifierGroup;
    sizeGroupId = group.id;
    mediumOptionId = group.options.find((o) => o.name === 'Medium')!.id;
    await createTestTenantB(prisma);
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
    await prisma.customer.deleteMany({
      where: {
        externalProvider: 'test',
        externalSubject: { startsWith: `test-customer-m4b-${run}` },
      },
    });
    await removePaymentAccountsForTest({
      tenantIds: [T1, TEST_TENANT_B_ID],
      externalAccountIds: [ACCT_1, ACCT_B],
      externalEventIds: eventIds,
    });
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await removeTestTenantB(prisma);
    await moduleRef.close();
    process.env = { ...originalEnv };
  });

  beforeEach(() => {
    allowed.clear();
    allowed.add(T1);
    intents.createError = null;
    intents.retrieveError = null;
    intents.cancelError = null;
    intents.loseNextCancelResponse = false;
    intents.beforeCancel = null;
    intents.create.mockClear();
    intents.retrieve.mockClear();
    intents.stripeCancel.mockClear();
    delete process.env.PAYMENT_ABANDON_AFTER_MINUTES;
  });

  // --- fixtures ------------------------------------------------------------------

  const body = (): LabelledCheckoutRequest => ({
    clientRef: `m4b_${randomUUID()}`,
    locationId,
    guest: { name: 'Cleanup Guest', phone: '5551230000' },
    lines: [
      {
        productId,
        quantity: 2,
        selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
      },
    ],
  });

  async function coupon(): Promise<string> {
    const code = `M4B${randomUUID().slice(0, 8)}`.toUpperCase();
    const promotion = await prisma.promotion.create({
      data: {
        tenantId: T1,
        name: `M4b coupon ${code}`,
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

  async function member(): Promise<CustomerIdentity> {
    const identity = {
      provider: 'test' as const,
      subject: `test-customer-m4b-${run}-${randomUUID()}`,
      email: `m4b-${randomUUID().slice(0, 8)}@example.com`,
      name: null,
      emailVerified: null,
    };
    await prisma.customer.create({
      data: {
        tenantId: T1,
        externalProvider: identity.provider,
        externalSubject: identity.subject,
        email: identity.email,
      },
    });
    return identity;
  }

  const tokenOf = (r: LabelledCheckoutRequest, identity?: CustomerIdentity) =>
    checkoutTokenFor(checkout, r.clientRef, locationId, identity, t1);

  async function submit(
    r: LabelledCheckoutRequest,
    identity?: CustomerIdentity,
  ): Promise<CheckoutSubmitResult> {
    return checkout.submit(
      {
        locationId: r.locationId,
        guest: r.guest,
        lines: r.lines,
        couponCode: r.couponCode,
        checkoutToken: await tokenOf(r, identity),
      },
      identity,
      t1,
    );
  }

  const attemptOf = async (r: LabelledCheckoutRequest) => {
    const all = await prisma.paymentAttempt.findMany({
      where: attemptsOfCheckout(r.clientRef),
    });
    expect(all).toHaveLength(1);
    return all[0];
  };
  const ordersOf = async (r: LabelledCheckoutRequest) =>
    prisma.order.count({
      where: { paymentAttemptId: (await attemptOf(r)).id },
    });
  const holds = async (r: LabelledCheckoutRequest, status: string) =>
    prisma.financialHold.count({
      where: {
        paymentAttemptId: (await attemptOf(r)).id,
        status: status as 'ACTIVE',
      },
    });
  const caseOf = async (r: LabelledCheckoutRequest) =>
    prisma.paymentReconciliationCase.findFirst({
      where: { paymentAttemptId: (await attemptOf(r)).id },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });

  // A Stripe payment waiting for its customer, with a coupon hold.
  async function waiting(identity?: CustomerIdentity) {
    const r = { ...body(), couponCode: await coupon() };
    const result = await submit(r, identity);
    expect(result.outcome).toBe('PAYMENT_REQUIRED');
    const attempt = await attemptOf(r);
    expect(await holds(r, 'ACTIVE')).toBe(1);
    return { r, attempt, intentId: attempt.providerReference! };
  }

  const heartbeat = async (
    r: LabelledCheckoutRequest,
    over: {
      locationId?: string;
      identity?: CustomerIdentity;
      tenant?: ReturnType<typeof tenantContextFor>;
    } = {},
  ) =>
    checkout.recordPaymentActivity(
      {
        locationId: over.locationId ?? locationId,
        checkoutToken: await tokenOf(r),
      },
      over.identity,
      over.tenant ?? t1,
    );

  const PAST = 121 * MIN; // past the default 120-minute deadline
  const abandon = async (r: LabelledCheckoutRequest, now = later(PAST)) =>
    recovery.cancelAbandoned((await attemptOf(r)).id, T1, now);

  // --- configuration ------------------------------------------------------------

  it('is OFF by default, with a 120-minute deadline configurable from 30 to 1440 minutes (fail closed)', () => {
    expect(abandonedIntentCancelEnabled({})).toBe(false);
    expect(
      abandonedIntentCancelEnabled({
        PAYMENT_ABANDONED_INTENT_CANCEL_ENABLED: 'true',
      }),
    ).toBe(false);
    expect(
      abandonedIntentCancelEnabled({
        PAYMENT_ABANDONED_INTENT_CANCEL_ENABLED: '1',
      }),
    ).toBe(true);
    expect(abandonAfterMinutes({})).toBe(120);
    expect(abandonAfterMinutes({ PAYMENT_ABANDON_AFTER_MINUTES: '30' })).toBe(
      30,
    );
    expect(abandonAfterMinutes({ PAYMENT_ABANDON_AFTER_MINUTES: '1440' })).toBe(
      1440,
    );
    for (const bad of ['29', '1441', '0', '-60', '90.5', 'two hours', '1e2']) {
      expect(() =>
        abandonAfterMinutes({ PAYMENT_ABANDON_AFTER_MINUTES: bad }),
      ).toThrow(PaymentRecoveryConfigurationError);
    }
    // A malformed deadline stops the process from starting.
    process.env.PAYMENT_ABANDON_AFTER_MINUTES = '5';
    expect(() =>
      new PaymentRecoveryService(
        prisma,
        checkout,
        null as never,
      ).onModuleInit(),
    ).toThrow(PaymentRecoveryConfigurationError);
  });

  // --- the heartbeat ------------------------------------------------------------

  it('the heartbeat route uses the checkout rate limit and answers nothing (204)', () => {
    const handler = Object.getOwnPropertyDescriptor(
      OrdersController.prototype,
      'recordPaymentActivity',
    )!.value as object;
    expect(Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, handler)).toBe(
      'checkout',
    );
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(204);
  });

  it("records activity only on the session's live Stripe payment, at most once a minute, from the server's clock", async () => {
    const { r, attempt } = await waiting();
    expect(attempt.customerActiveAt).toBeNull();
    await heartbeat(r);
    const first = (await attemptOf(r)).customerActiveAt!;
    expect(first).toBeInstanceOf(Date);
    await heartbeat(r);
    expect((await attemptOf(r)).customerActiveAt).toEqual(first); // throttled
    await prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: { customerActiveAt: new Date(Date.now() - 2 * MIN) },
    });
    await heartbeat(r);
    expect((await attemptOf(r)).customerActiveAt!.getTime()).toBeGreaterThan(
      Date.now() - 30_000,
    );
    // A paid payment is not "waiting": nothing recorded.
    intents.succeed(attempt.providerReference!);
    await checkout.checkPayment(
      { locationId, checkoutToken: await tokenOf(r) },
      undefined,
      t1,
    );
    expect((await attemptOf(r)).status).toBe('SUCCEEDED');
    await prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: { customerActiveAt: null },
    });
    await heartbeat(r);
    expect((await attemptOf(r)).customerActiveAt).toBeNull();
  });

  it('refuses another location, another business, an invalid token and another customer (nothing recorded)', async () => {
    const { r, attempt } = await waiting();
    expect(
      await outcomeOf(() => heartbeat(r, { locationId: otherLocationId })),
    ).toMatchObject({ ok: false });
    expect(
      await outcomeOf(() =>
        heartbeat(r, { tenant: tenantContextFor(TEST_TENANT_B_ID) }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await outcomeOf(() =>
        checkout.recordPaymentActivity(
          { locationId, checkoutToken: `cs_${'x'.repeat(43)}` },
          undefined,
          t1,
        ),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await outcomeOf(() =>
        checkout.recordPaymentActivity(
          { locationId, checkoutToken: 'not-a-token' },
          undefined,
          t1,
        ),
      ),
    ).toMatchObject({ ok: false });
    // A guest checkout is not a signed-in customer's.
    expect(
      await outcomeOf(async () => heartbeat(r, { identity: await member() })),
    ).toMatchObject({ ok: false });
    expect((await attemptOf(r)).customerActiveAt).toBeNull();

    // A signed-in customer's checkout: theirs only.
    const owner = await member();
    const own = await waiting(owner);
    await checkout.recordPaymentActivity(
      { locationId, checkoutToken: await tokenOf(own.r, owner) },
      owner,
      t1,
    );
    expect((await attemptOf(own.r)).customerActiveAt).not.toBeNull();
    const stranger = await member();
    await prisma.paymentAttempt.update({
      where: { id: own.attempt.id },
      data: { customerActiveAt: null },
    });
    expect(
      await outcomeOf(async () =>
        checkout.recordPaymentActivity(
          { locationId, checkoutToken: await tokenOf(own.r, owner) },
          stranger,
          t1,
        ),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await outcomeOf(async () =>
        checkout.recordPaymentActivity(
          { locationId, checkoutToken: await tokenOf(own.r, owner) },
          undefined,
          t1,
        ),
      ),
    ).toMatchObject({ ok: false });
    expect((await attemptOf(own.r)).customerActiveAt).toBeNull();
    void attempt;
  });

  // --- what counts as abandoned --------------------------------------------------

  it('an active checkout is never a candidate: inactivity counts from the later of creation and the last heartbeat', async () => {
    const { r, attempt } = await waiting();
    const ids = async (now: Date) =>
      (await recovery.abandonmentCandidates(now)).map((c) => c.id);
    expect(await ids(later(60 * MIN))).not.toContain(attempt.id); // too recent
    expect(await ids(later(PAST))).toContain(attempt.id);
    // A heartbeat an hour from now keeps it open until 2 hours after that.
    await prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: { customerActiveAt: later(60 * MIN) },
    });
    expect(await ids(later(PAST))).not.toContain(attempt.id);
    expect(await ids(later(60 * MIN + PAST))).toContain(attempt.id);
    expect(await abandon(r, later(PAST))).toEqual({ kind: 'not_eligible' });
    expect(intents.stripeCancel).not.toHaveBeenCalled();
  });

  it('honours a configured deadline', async () => {
    const { attempt } = await waiting();
    process.env.PAYMENT_ABANDON_AFTER_MINUTES = '30';
    expect(
      (await recovery.abandonmentCandidates(later(31 * MIN))).map((c) => c.id),
    ).toContain(attempt.id);
    process.env.PAYMENT_ABANDON_AFTER_MINUTES = '1440';
    expect(
      (await recovery.abandonmentCandidates(later(PAST))).map((c) => c.id),
    ).not.toContain(attempt.id);
  });

  // --- cancelling ---------------------------------------------------------------

  it('cancels an unpaid abandoned intent on its own account, reads it back, releases its holds and resolves its case', async () => {
    const { r, attempt, intentId } = await waiting();
    expect(await abandon(r)).toEqual({ kind: 'settled', result: 'CANCELLED' });
    expect(intents.stripeCancel).toHaveBeenCalledTimes(1);
    expect(intents.stripeCancel).toHaveBeenCalledWith(
      intentId,
      { cancellation_reason: 'abandoned' },
      {
        stripeAccount: ACCT_1,
        idempotencyKey: `${attempt.idempotencyKey}:abandon`,
      },
    );
    // The intent was read back AFTER the cancel request.
    const lastRetrieve = intents.retrieve.mock.invocationCallOrder.at(-1)!;
    expect(lastRetrieve).toBeGreaterThan(
      intents.stripeCancel.mock.invocationCallOrder[0],
    );
    expect(await attemptOf(r)).toMatchObject({
      status: 'FAILED',
      paymentState: 'FAILED',
    });
    expect(await holds(r, 'RELEASED')).toBe(1);
    expect(await holds(r, 'ACTIVE')).toBe(0);
    expect(await caseOf(r)).toMatchObject({
      status: 'RESOLVED',
      resolution: 'NOT_CHARGED',
    });
    expect(await ordersOf(r)).toBe(0);
    // Never twice: not eligible any more, no second cancel.
    expect(await abandon(r)).toEqual({ kind: 'not_eligible' });
    expect(intents.stripeCancel).toHaveBeenCalledTimes(1);
  });

  it('never cancels an authentication in progress (requires_action / requires_confirmation): held and visible as STRIPE_AUTHENTICATION_STALE', async () => {
    for (const status of [
      'requires_action',
      'requires_confirmation',
    ] as const) {
      const { r, attempt, intentId } = await waiting();
      intents.set(intentId, { status });
      expect(await abandon(r)).toEqual({
        kind: 'failed',
        failure: 'STRIPE_AUTHENTICATION_STALE',
        retryable: false,
      });
      expect(intents.stripeCancel).not.toHaveBeenCalled();
      expect(await attemptOf(r)).toMatchObject({
        status: 'PENDING',
        paymentState: 'REQUIRES_CUSTOMER_ACTION',
      });
      expect(await holds(r, 'ACTIVE')).toBe(1);
      expect((await caseOf(r))!.events.map((e) => e.action)).toContain(
        'STRIPE_AUTHENTICATION_STALE',
      );
      // Set aside: the sweep never tries it again, and support sees it.
      expect(
        (await recovery.abandonmentCandidates(later(24 * 60 * MIN))).map(
          (c) => c.id,
        ),
      ).not.toContain(attempt.id);
      expect((await cases.detail((await caseOf(r))!.id)).case.category).toBe(
        'NEEDS_ATTENTION',
      );
    }
  });

  it('never cancels a processing or paid intent: settled from Stripe instead (paid: one order)', async () => {
    const processing = await waiting();
    intents.process(processing.intentId);
    expect(await abandon(processing.r)).toEqual({
      kind: 'settled',
      result: 'PROCESSING',
    });
    expect(await attemptOf(processing.r)).toMatchObject({
      paymentState: 'AWAITING_CONFIRMATION',
    });
    expect(await holds(processing.r, 'ACTIVE')).toBe(1);

    const paid = await waiting();
    intents.succeed(paid.intentId);
    expect(await abandon(paid.r)).toEqual({ kind: 'settled', result: 'PAID' });
    expect(await ordersOf(paid.r)).toBe(1);
    expect(await holds(paid.r, 'CONSUMED')).toBe(1);
    expect(intents.stripeCancel).not.toHaveBeenCalled();
  });

  it.each([
    ['a pending latest charge', { latest_charge: { status: 'pending' } }],
    ['a succeeded latest charge', { latest_charge: { status: 'succeeded' } }],
    ['an unexpanded latest charge', { latest_charge: 'ch_unexpanded' }],
    ['a pending next action', { next_action: { type: 'use_stripe_sdk' } }],
    ['another amount', { amount: 1 }],
    ['another currency', { currency: 'eur' }],
  ])(
    'never cancels with %s: held, set aside for people',
    async (_label, change) => {
      const { r, intentId } = await waiting();
      intents.set(intentId, change as unknown as Partial<Stripe.PaymentIntent>);
      expect(await abandon(r)).toEqual({
        kind: 'failed',
        failure: 'STRIPE_ABANDON_UNSAFE',
        retryable: false,
      });
      expect(intents.stripeCancel).not.toHaveBeenCalled();
      expect(await attemptOf(r)).toMatchObject({ status: 'PENDING' });
      expect(await holds(r, 'ACTIVE')).toBe(1);
    },
  );

  it('a failed latest charge (a declined card) does not block cancelling', async () => {
    const { r, intentId } = await waiting();
    intents.set(intentId, {
      latest_charge: { status: 'failed' } as Stripe.Charge,
      last_payment_error: { type: 'card_error' },
    });
    expect(await abandon(r)).toEqual({ kind: 'settled', result: 'CANCELLED' });
    expect(await holds(r, 'RELEASED')).toBe(1);
  });

  it('money received on an intent is never cancelled', async () => {
    const { r, intentId } = await waiting();
    intents.set(intentId, { amount_received: 100 });
    const outcome = await abandon(r);
    expect(outcome.kind).toBe('failed');
    expect(intents.stripeCancel).not.toHaveBeenCalled();
    expect(await holds(r, 'ACTIVE')).toBe(1);
  });

  // --- uncertain answers --------------------------------------------------------

  it('a cancel whose answer was lost is proven by the read-back (cancelled, holds released)', async () => {
    const { r } = await waiting();
    intents.loseNextCancelResponse = true;
    expect(await abandon(r)).toEqual({ kind: 'settled', result: 'CANCELLED' });
    expect(await holds(r, 'RELEASED')).toBe(1);
  });

  it('a cancel that failed (nothing happened at Stripe) changes nothing: holds kept, retried later', async () => {
    const { r } = await waiting();
    intents.cancelError = stripeError('StripeAPIError', undefined, 500);
    expect(await abandon(r)).toEqual({
      kind: 'failed',
      failure: 'STRIPE_CANCEL_UNCONFIRMED',
      retryable: true,
    });
    expect(await attemptOf(r)).toMatchObject({
      status: 'PENDING',
      paymentState: 'REQUIRES_CUSTOMER_ACTION',
    });
    expect(await holds(r, 'ACTIVE')).toBe(1);
    // Retried after its backoff: cancelled then.
    expect(await abandon(r, later(PAST + 10 * MIN))).toEqual({
      kind: 'settled',
      result: 'CANCELLED',
    });
    expect(await holds(r, 'RELEASED')).toBe(1);
  });

  it('a read-back that fails after the cancel releases nothing; the next try proves it', async () => {
    const { r } = await waiting();
    intents.beforeCancel = () => {
      intents.retrieveError = stripeError('StripeConnectionError');
    };
    expect(await abandon(r)).toEqual({
      kind: 'failed',
      failure: 'STRIPE_UNREADABLE',
      retryable: true,
    });
    expect(await attemptOf(r)).toMatchObject({ status: 'PENDING' });
    expect(await holds(r, 'ACTIVE')).toBe(1);
    intents.beforeCancel = null;
    expect(await abandon(r, later(PAST + 10 * MIN))).toEqual({
      kind: 'settled',
      result: 'CANCELLED',
    });
    expect(await holds(r, 'RELEASED')).toBe(1);
    // A late Stripe webhook for the cancellation changes nothing more.
    const verified = provider.verifyPaymentEvent(
      signedPaymentEvent(stripe, {
        id: evt(),
        type: 'payment_intent.canceled',
        account: ACCT_1,
        intent: {
          id: (await attemptOf(r)).providerReference!,
          metadata: { centerivo_payment_attempt_id: 'x' },
        },
      }),
    );
    expect(await events.handle(verified)).toBe(true);
    expect(await attemptOf(r)).toMatchObject({ status: 'FAILED' });
    expect(await holds(r, 'RELEASED')).toBe(1);
  });

  // --- races ----------------------------------------------------------------------

  it('a customer paying as the cancel is sent: Stripe refuses the cancel, the read-back finds it paid, one order', async () => {
    const { r, intentId } = await waiting();
    intents.beforeCancel = () => intents.succeed(intentId);
    expect(await abandon(r)).toEqual({ kind: 'settled', result: 'PAID' });
    expect(await attemptOf(r)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await ordersOf(r)).toBe(1);
    expect(await holds(r, 'CONSUMED')).toBe(1);
  });

  it('a heartbeat arriving before the final check keeps the checkout open (no cancel)', async () => {
    const { r, attempt } = await waiting();
    // The customer's heartbeat lands while Stripe is being read (after the
    // first eligibility check, before the final one).
    const realRetrieve = intents.retrieve.getMockImplementation()!;
    intents.retrieve.mockImplementationOnce(async (...args) => {
      await prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { customerActiveAt: later(PAST) },
      });
      return realRetrieve(...args);
    });
    expect(await abandon(r)).toEqual({
      kind: 'settled',
      result: 'STILL_ACTIVE',
    });
    expect(intents.stripeCancel).not.toHaveBeenCalled();
    expect(await holds(r, 'ACTIVE')).toBe(1);
  });

  it.each([
    [
      '3-D Secure',
      'requires_action',
      { kind: 'settled', result: 'STILL_ACTIVE' },
    ],
    ['processing', 'processing', { kind: 'settled', result: 'PROCESSING' }],
  ] as const)(
    'a customer who confirms in the browser between the Stripe reads (%s) is never cancelled: Stripe is read again just before the cancel',
    async (_label, moved, expected) => {
      const { r, intentId } = await waiting();
      // The first read sees an unpaid intent; the customer then confirms (no
      // server call, so no heartbeat) before the pre-cancel read.
      const realRetrieve = intents.retrieve.getMockImplementation()!;
      intents.retrieve.mockImplementationOnce(async (...args) => {
        const first = await realRetrieve(...args);
        intents.set(intentId, { status: moved });
        return first;
      });
      expect(await abandon(r)).toEqual(expected);
      expect(intents.stripeCancel).not.toHaveBeenCalled();
      expect(await attemptOf(r)).toMatchObject({ status: 'PENDING' });
      expect(await holds(r, 'ACTIVE')).toBe(1);
    },
  );

  it('a returning customer does not use up the automatic attempts of a later abandonment', async () => {
    const { r, attempt } = await waiting();
    let when = Date.now() + PAST;
    for (let i = 0; i < MAX_AUTOMATIC_ATTEMPTS + 1; i++) {
      // Each time, the customer's heartbeat lands during the Stripe read.
      const realRetrieve = intents.retrieve.getMockImplementation()!;
      const at = new Date(when);
      intents.retrieve.mockImplementationOnce(async (...args) => {
        await prisma.paymentAttempt.update({
          where: { id: attempt.id },
          data: { customerActiveAt: at },
        });
        return realRetrieve(...args);
      });
      expect(await abandon(r, at)).toEqual({
        kind: 'settled',
        result: 'STILL_ACTIVE',
      });
      when += PAST + MIN;
    }
    // Abandoned for real now: still a candidate, and cancelled.
    expect(
      (await recovery.abandonmentCandidates(new Date(when))).map((c) => c.id),
    ).toContain(attempt.id);
    expect(await abandon(r, new Date(when))).toEqual({
      kind: 'settled',
      result: 'CANCELLED',
    });
    expect(await holds(r, 'RELEASED')).toBe(1);
  });

  it('concurrent workers cancel at most once', async () => {
    const { r } = await waiting();
    const results = await Promise.all([abandon(r), abandon(r), abandon(r)]);
    expect(results.filter((o) => o.kind === 'settled')).toHaveLength(1);
    expect(intents.stripeCancel).toHaveBeenCalledTimes(1);
    expect(await holds(r, 'RELEASED')).toBe(1);
  });

  // --- the sweep ------------------------------------------------------------------

  it('the sweep cancels abandoned payments only with its own switch on; the M4a phases are unchanged', async () => {
    const off = await waiting();
    delete process.env.PAYMENT_ABANDONED_INTENT_CANCEL_ENABLED;
    await recovery.sweep(later(PAST));
    expect(await attemptOf(off.r)).toMatchObject({ status: 'PENDING' });
    expect(intents.stripeCancel).not.toHaveBeenCalled();

    process.env.PAYMENT_ABANDONED_INTENT_CANCEL_ENABLED = '1';
    try {
      const swept = await recovery.sweep(later(PAST));
      expect(swept.swept).toBe(true);
      expect(await attemptOf(off.r)).toMatchObject({ status: 'FAILED' });
      expect(await holds(off.r, 'RELEASED')).toBe(1);
    } finally {
      delete process.env.PAYMENT_ABANDONED_INTENT_CANCEL_ENABLED;
    }
  });

  it('caps automatic attempts: an intent Stripe keeps refusing to cancel is set aside, holds kept', async () => {
    const { r, attempt } = await waiting();
    let when = Date.now() + PAST;
    for (let i = 0; i < MAX_AUTOMATIC_ATTEMPTS; i++) {
      expect(
        (await recovery.abandonmentCandidates(new Date(when))).map((c) => c.id),
      ).toContain(attempt.id);
      intents.cancelError = stripeError('StripeAPIError', undefined, 500);
      expect(await abandon(r, new Date(when))).toMatchObject({
        kind: 'failed',
        retryable: true,
      });
      when += 7 * 60 * MIN;
    }
    expect(
      (await recovery.abandonmentCandidates(new Date(when))).map((c) => c.id),
    ).not.toContain(attempt.id);
    expect(await holds(r, 'ACTIVE')).toBe(1);
  });
});
