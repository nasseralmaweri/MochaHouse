import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
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
import { PaymentEventsService } from '../restaurant-payments/payment-events/payment-events.service';
import {
  MAX_AUTOMATIC_ATTEMPTS,
  PaymentRecoveryService,
  RECOVERY_GRACE_MS,
  STRIPE_CHARGING_GRACE_MS,
} from './application/payment-recovery.service';
import { PlatformPaymentCasesService } from './application/platform-payment-cases.service';
import { STRIPE_CREATE_REPLAY_WINDOW_MS } from '../payment/payment-intent-recovery';
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

// ESP-04 M4a — Stripe payment OUTCOME recovery, against a real disposable
// database with real services and the real Stripe adapter over an
// in-memory PaymentIntents stand-in (no network, no Stripe account). Covers:
//   * a held payment (CHARGING / UNKNOWN / AWAITING_CONFIRMATION) read back
//     from Stripe on its own account and moved only on Stripe's answer:
//     paid (one order), waiting again, processing, cancelled (holds
//     released), a different amount (held for people);
//   * a payment that never recorded its intent: its creation replayed under
//     the ORIGINAL key, account and parameters — finding the intent Stripe
//     created (a lost response) or creating it for the first time (never
//     reached) — never a second intent, and never after the 20-hour window
//     (even if Stripe pruned the key); a cached 500, a conflict or a local
//     refusal changes nothing; the automatic attempts are capped and the
//     payment is then set aside for people, holds kept;
//   * a crash after Stripe answered; concurrency (one recovery at a time);
//   * unmatched Stripe events reconciled directly once their payment names
//     the intent, with the event re-drive OFF — never through another
//     business's account or forged metadata, and never starved;
//   * "Recheck with Stripe": the same path, audited, reason kept as a note.

jest.setTimeout(300_000);

const T1 = TENANT_1_MOCHA_HOUSE_ID;
const later = (ms: number) => new Date(Date.now() + ms);
const paymentEventRedriveIsOff = () =>
  process.env.RESTAURANT_PAYMENT_EVENT_REDRIVE_ENABLED !== '1';

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

describe('ESP-04 M4a Stripe outcome recovery (integration, offline Stripe)', () => {
  const allowed = new Set<string>([T1]);
  const { stripe, intents, provider } = fakeStripePayments(allowed);
  const t1 = tenantContextFor(T1);
  const run = randomUUID().slice(0, 8);
  const ACCT_1 = `acct_1M4a${run}`;
  const ACCT_B = `acct_1M4b${run}`;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let checkout: CheckoutService;
  let events: PaymentEventsService;
  let recovery: PaymentRecoveryService;
  let cases: PlatformPaymentCasesService;
  let locationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;
  const userIds: string[] = [];
  const promotions: string[] = [];
  const eventIds: string[] = [];
  const originalEnv = { ...process.env };

  const evt = () => {
    const id = `evt_M4a${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    eventIds.push(id);
    return id;
  };

  async function readyAccount(tenantId: string, accountId: string) {
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:m4a-${tenantId.slice(-4)}-${run}`,
        email: `m4a-${tenantId.slice(-4)}-${run}@example.test`,
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
    delete process.env.RESTAURANT_PAYMENT_EVENT_REDRIVE_ENABLED;
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
    // Platform audit history is append-only: this suite's operator and its
    // audit rows (uniquely named) stay in the disposable database.
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
    intents.createAmountOverride = null;
    intents.loseNextCreateResponse = false;
    intents.saved500Keys.clear();
    intents.create.mockClear();
    intents.retrieve.mockClear();
  });

  // --- fixtures ------------------------------------------------------------------

  const body = (): LabelledCheckoutRequest => ({
    clientRef: `m4a_${randomUUID()}`,
    locationId,
    guest: { name: 'Recovery Guest', phone: '5551239999' },
    lines: [
      {
        productId,
        quantity: 2,
        selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
      },
    ],
  });

  async function coupon(): Promise<string> {
    const code = `M4A${randomUUID().slice(0, 8)}`.toUpperCase();
    const promotion = await prisma.promotion.create({
      data: {
        tenantId: T1,
        name: `M4a coupon ${code}`,
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

  async function submit(
    r: LabelledCheckoutRequest,
  ): Promise<CheckoutSubmitResult> {
    const checkoutToken = await checkoutTokenFor(
      checkout,
      r.clientRef,
      locationId,
      undefined,
      t1,
    );
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
  const recheck = async (r: LabelledCheckoutRequest, now: Date = new Date()) =>
    recovery.recheckStripeOutcome(
      (await attemptOf(r)).id,
      T1,
      { trigger: 'automatic' },
      now,
    );

  // A payment whose creation answer was lost: Stripe created the intent.
  async function lostResponse() {
    const r = { ...body(), couponCode: await coupon() };
    intents.loseNextCreateResponse = true;
    expect(await outcomeOf(() => submit(r))).toMatchObject({
      ok: false,
      status: 409,
    });
    const attempt = await attemptOf(r);
    expect(attempt).toMatchObject({
      paymentState: 'UNKNOWN',
      providerReference: null,
    });
    expect(intents.intentsOn(ACCT_1)).toContain(intents.last());
    return { r, attempt, intentId: intents.last() };
  }

  // A payment whose creation never reached Stripe.
  async function neverReached() {
    const r = { ...body(), couponCode: await coupon() };
    const before = intents.intents.size;
    intents.createError = stripeError('StripeConnectionError');
    expect(await outcomeOf(() => submit(r))).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(intents.intents.size).toBe(before);
    return { r, attempt: await attemptOf(r) };
  }

  // --- replaying a lost creation -------------------------------------------------

  it('finds the intent Stripe created for a lost response by replaying the ORIGINAL request: same key, account and parameters, no second intent', async () => {
    const { r, attempt, intentId } = await lostResponse();
    const before = intents.intentsOn(ACCT_1).length;
    const [originalParams, originalOptions] = intents.create.mock.calls[0];
    intents.create.mockClear();

    expect(await recheck(r)).toEqual({
      kind: 'settled',
      result: 'WAITING_FOR_CUSTOMER',
    });
    const [params, options] = intents.create.mock.calls[0];
    expect(JSON.stringify(params)).toBe(JSON.stringify(originalParams));
    expect(options).toEqual(originalOptions);
    expect(options).toEqual({
      stripeAccount: ACCT_1,
      idempotencyKey: attempt.idempotencyKey,
    });
    expect(intents.intentsOn(ACCT_1)).toHaveLength(before);
    expect(await attemptOf(r)).toMatchObject({
      status: 'PENDING',
      paymentState: 'REQUIRES_CUSTOMER_ACTION',
      providerReference: intentId,
      providerAccountId: ACCT_1,
    });
    expect((await caseOf(r))!.events.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'STRIPE_RECHECK_STARTED',
        'STRIPE_INTENT_LINKED',
        'STRIPE_RECHECK_SUCCEEDED',
      ]),
    );
    // Live again with its holds, and no second payment attempt.
    expect(await holds(r, 'ACTIVE')).toBe(1);
    // ...and the customer can resume and pay it.
    intents.succeed(intentId);
    const checked = await checkout.checkPayment(
      {
        locationId,
        checkoutToken: await checkoutTokenFor(
          checkout,
          r.clientRef,
          locationId,
          undefined,
          t1,
        ),
      },
      undefined,
      t1,
    );
    expect(checked.outcome).toBe('COMPLETED');
    expect(await ordersOf(r)).toBe(1);
  });

  it('creates the intent for the first time when the original never reached Stripe (still one intent per key)', async () => {
    const { r, attempt } = await neverReached();
    expect(await recheck(r)).toEqual({
      kind: 'settled',
      result: 'WAITING_FOR_CUSTOMER',
    });
    const linked = await attemptOf(r);
    expect(linked.providerReference).toMatch(/^pi_/);
    expect(linked.id).toBe(attempt.id);
    // The original failed attempt plus the one replay — one intent.
    expect(
      intents
        .intentsOn(ACCT_1)
        .filter(
          (id) =>
            intents.intents.get(id)!.intent.metadata
              .centerivo_payment_attempt_id === attempt.id,
        ),
    ).toEqual([linked.providerReference]);
    expect(await holds(r, 'ACTIVE')).toBe(1);
  });

  it('never replays after the 20-hour window, even if Stripe has pruned the key: held, set aside for people', async () => {
    const { r, attempt } = await neverReached();
    intents.prune(attempt.idempotencyKey);
    const afterWindow = new Date(
      attempt.createdAt.getTime() + STRIPE_CREATE_REPLAY_WINDOW_MS + 1_000,
    );
    intents.create.mockClear();

    expect(await recheck(r, afterWindow)).toEqual({
      kind: 'failed',
      failure: 'STRIPE_CREATE_EXPIRED',
      retryable: false,
    });
    expect(intents.create).not.toHaveBeenCalled();
    expect(await attemptOf(r)).toMatchObject({
      paymentState: 'UNKNOWN',
      providerReference: null,
    });
    expect(await holds(r, 'ACTIVE')).toBe(1);
    expect(await holds(r, 'RELEASED')).toBe(0);
    // Set aside: the sweep never picks it again.
    const due = await recovery.stripeCandidates(later(24 * 60 * 60_000));
    expect(due.map((d) => d.id)).not.toContain(attempt.id);
    const summary = (await cases.detail((await caseOf(r))!.id)).case;
    expect(summary.category).toBe('NEEDS_ATTENTION');
    expect(summary.stripe).toMatchObject({
      lastFailure: 'STRIPE_CREATE_EXPIRED',
      nextAutomaticAttemptAt: null,
    });
  });

  it('just inside the window the same payment IS replayed (the window is the gate)', async () => {
    const { r, attempt } = await neverReached();
    const justInside = new Date(
      attempt.createdAt.getTime() + STRIPE_CREATE_REPLAY_WINDOW_MS - 60_000,
    );
    expect(await recheck(r, justInside)).toEqual({
      kind: 'settled',
      result: 'WAITING_FOR_CUSTOMER',
    });
  });

  it('a cached 500 is never proof of anything: unchanged each time, capped, then set aside with its holds', async () => {
    const { r, attempt } = await neverReached();
    intents.saved500Keys.add(attempt.idempotencyKey);
    let when = Date.now() + RECOVERY_GRACE_MS + 60_000;
    for (let i = 0; i < MAX_AUTOMATIC_ATTEMPTS; i++) {
      const due = await recovery.stripeCandidates(new Date(when));
      expect(due.map((d) => d.id)).toContain(attempt.id);
      expect(await recheck(r, new Date(when))).toEqual({
        kind: 'failed',
        failure: 'STRIPE_UNREADABLE',
        retryable: true,
      });
      // Past every backoff (5 min × 2ⁿ), still inside the 20-hour window.
      when += 2 * 60 * 60_000;
    }
    expect(
      (await recovery.stripeCandidates(new Date(when))).map((d) => d.id),
    ).not.toContain(attempt.id);
    expect(await attemptOf(r)).toMatchObject({
      paymentState: 'UNKNOWN',
      providerReference: null,
    });
    expect(await holds(r, 'ACTIVE')).toBe(1);
    expect(
      intents
        .intentsOn(ACCT_1)
        .filter(
          (id) =>
            intents.intents.get(id)!.intent.metadata
              .centerivo_payment_attempt_id === attempt.id,
        ),
    ).toHaveLength(0);
    expect((await cases.detail((await caseOf(r))!.id)).case.category).toBe(
      'NEEDS_ATTENTION',
    );
  });

  it('Stripe refusing the key with other parameters is set aside at once (never retried)', async () => {
    const { r } = await neverReached();
    intents.createError = stripeError(
      'StripeIdempotencyError',
      'idempotency_error',
      400,
    );
    expect(await recheck(r)).toEqual({
      kind: 'failed',
      failure: 'STRIPE_IDEMPOTENCY_CONFLICT',
      retryable: false,
    });
    expect(await holds(r, 'ACTIVE')).toBe(1);
  });

  it('a LOCAL refusal during a replay (the business left the allowlist) proves nothing about the original: never released', async () => {
    const { r } = await lostResponse();
    allowed.clear();
    expect(await recheck(r)).toEqual({
      kind: 'failed',
      failure: 'STRIPE_UNREADABLE',
      retryable: true,
    });
    expect(await attemptOf(r)).toMatchObject({
      status: 'PENDING',
      paymentState: 'UNKNOWN',
    });
    expect(await holds(r, 'ACTIVE')).toBe(1);
    expect(await holds(r, 'RELEASED')).toBe(0);
  });

  // --- reading a known intent back -----------------------------------------------

  async function waitingPayment() {
    const r = { ...body(), couponCode: await coupon() };
    const result = await submit(r);
    expect(result.outcome).toBe('PAYMENT_REQUIRED');
    const attempt = await attemptOf(r);
    return { r, attempt, intentId: attempt.providerReference! };
  }

  // A crash after Stripe answered: the reference was kept, the outcome not.
  async function crashedAfterAnswer(
    state: 'CHARGING' | 'UNKNOWN' | 'AWAITING_CONFIRMATION',
  ) {
    const w = await waitingPayment();
    await prisma.paymentAttempt.update({
      where: { id: w.attempt.id },
      data: { paymentState: state },
    });
    return w;
  }

  it('a crash after Stripe charged (CHARGING with its intent): paid, ONE order, holds consumed, case resolved', async () => {
    const { r, intentId } = await crashedAfterAnswer('CHARGING');
    intents.succeed(intentId);
    // CHARGING is left alone while its first request may still be running.
    expect(
      (await recovery.stripeCandidates(later(RECOVERY_GRACE_MS + 1_000))).map(
        (d) => d.id,
      ),
    ).not.toContain((await attemptOf(r)).id);
    expect(
      (
        await recovery.stripeCandidates(
          later(STRIPE_CHARGING_GRACE_MS + 60_000),
        )
      ).map((d) => d.id),
    ).toContain((await attemptOf(r)).id);

    expect(await recheck(r)).toEqual({ kind: 'settled', result: 'PAID' });
    expect(await attemptOf(r)).toMatchObject({
      status: 'SUCCEEDED',
      paymentState: 'SUCCEEDED',
    });
    expect(await ordersOf(r)).toBe(1);
    expect(await holds(r, 'CONSUMED')).toBe(1);
    expect(await caseOf(r)).toMatchObject({
      status: 'RESOLVED',
      resolution: 'FULFILLED',
    });
    // Rechecked again: nothing to do, still one order.
    expect(await recheck(r)).toEqual({ kind: 'not_applicable' });
    expect(await ordersOf(r)).toBe(1);
  });

  it('cancelled at Stripe with nothing taken: closed, holds released, case resolved NOT_CHARGED', async () => {
    const { r, intentId } = await crashedAfterAnswer('UNKNOWN');
    intents.cancel(intentId);
    expect(await recheck(r)).toEqual({
      kind: 'settled',
      result: 'NOT_CHARGED',
    });
    expect(await attemptOf(r)).toMatchObject({
      status: 'FAILED',
      paymentState: 'FAILED',
    });
    expect(await holds(r, 'RELEASED')).toBe(1);
    expect(await caseOf(r)).toMatchObject({
      status: 'RESOLVED',
      resolution: 'NOT_CHARGED',
    });
    expect(await ordersOf(r)).toBe(0);
  });

  it('processing stays held; when it later succeeds the order is created once', async () => {
    const { r, intentId } = await crashedAfterAnswer('UNKNOWN');
    intents.process(intentId);
    expect(await recheck(r)).toEqual({ kind: 'settled', result: 'PROCESSING' });
    expect(await attemptOf(r)).toMatchObject({
      status: 'PENDING',
      paymentState: 'AWAITING_CONFIRMATION',
    });
    expect(await holds(r, 'ACTIVE')).toBe(1);
    intents.succeed(intentId);
    expect(await recheck(r)).toEqual({ kind: 'settled', result: 'PAID' });
    expect(await ordersOf(r)).toBe(1);
  });

  it('a different amount taken is never paid or released: set aside for people', async () => {
    const { r, attempt, intentId } = await crashedAfterAnswer('UNKNOWN');
    intents.succeed(intentId, attempt.amount - 1);
    expect(await recheck(r)).toEqual({
      kind: 'failed',
      failure: 'STRIPE_AMOUNT_MISMATCH',
      retryable: false,
    });
    expect(await attemptOf(r)).toMatchObject({
      status: 'PENDING',
      paymentState: 'UNKNOWN',
    });
    expect(await holds(r, 'ACTIVE')).toBe(1);
    expect(await ordersOf(r)).toBe(0);
  });

  it("reads only on the payment's own account; an unreadable Stripe changes nothing", async () => {
    const { r, intentId } = await crashedAfterAnswer('UNKNOWN');
    intents.retrieveError = stripeError('StripeAPIError', undefined, 500);
    expect(await recheck(r)).toEqual({
      kind: 'failed',
      failure: 'STRIPE_UNREADABLE',
      retryable: true,
    });
    intents.succeed(intentId);
    expect(await recheck(r)).toEqual({ kind: 'settled', result: 'PAID' });
    for (const call of intents.retrieve.mock.calls) {
      expect(call[2]).toEqual({ stripeAccount: ACCT_1 });
    }
  });

  it('one recovery of a payment at a time: concurrent rechecks and a held lock never double anything', async () => {
    const { r, attempt, intentId } = await crashedAfterAnswer('UNKNOWN');
    intents.succeed(intentId);
    const lock = new Client({
      connectionString: process.env.DATABASE_URL!.split('?')[0],
    });
    await lock.connect();
    try {
      await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
        `esp03-payment-recovery:${T1}:${attempt.id}`,
      ]);
      expect(await recheck(r)).toEqual({ kind: 'busy' });
    } finally {
      await lock.query('SELECT pg_advisory_unlock_all()');
      await lock.end();
    }
    const both = await Promise.all([recheck(r), recheck(r), recheck(r)]);
    expect(both.filter((o) => o.kind === 'settled')).toHaveLength(1);
    expect(await ordersOf(r)).toBe(1);
    expect(await holds(r, 'CONSUMED')).toBe(1);
  });

  // --- unmatched events (corrected decision 7) -----------------------------------

  async function unmatchedEventFor(
    intentId: string,
    account = ACCT_1,
    metadata?: Record<string, string>,
  ) {
    const id = evt();
    const verified = provider.verifyPaymentEvent(
      signedPaymentEvent(stripe, {
        id,
        type: 'payment_intent.succeeded',
        account,
        intent: {
          id: intentId,
          metadata: metadata ?? { centerivo_payment_attempt_id: 'x' },
        },
      }),
    );
    expect(await events.handle(verified)).toBe(true);
    return id;
  }
  const eventRow = (id: string) =>
    prisma.restaurantPaymentProviderEvent.findUnique({
      where: {
        provider_externalEventId: { provider: 'stripe', externalEventId: id },
      },
    });

  it('an event that arrived before the intent was recorded is reconciled by the sweep, with re-drive OFF and no redelivery', async () => {
    const { r, intentId } = await lostResponse();
    intents.succeed(intentId);
    const id = await unmatchedEventFor(intentId);
    expect((await eventRow(id))!.status).toBe('UNMATCHED');
    expect(paymentEventRedriveIsOff()).toBe(true);

    // One sweep: the Stripe phase replays the lost creation (linking the
    // intent) and reads it back (paid, the order once); the unmatched phase
    // then reconciles the event that now names the payment.
    const swept = await recovery.sweep(later(RECOVERY_GRACE_MS + 60_000));
    expect(swept.swept).toBe(true);
    expect(await attemptOf(r)).toMatchObject({
      status: 'SUCCEEDED',
      providerReference: intentId,
    });
    expect(await ordersOf(r)).toBe(1);
    expect(await eventRow(id)).toMatchObject({
      status: 'PROCESSED',
      outcome: 'LINKED_BY_RECOVERY',
    });
  });

  it('the unmatched phase alone settles a held payment the event now names (and the whole sweep does both)', async () => {
    const { r, intentId } = await lostResponse();
    intents.succeed(intentId);
    const id = await unmatchedEventFor(intentId);
    // Link the intent without settling (as a crash right after linking).
    await prisma.paymentAttempt.update({
      where: { id: (await attemptOf(r)).id },
      data: { providerReference: intentId },
    });
    // The event was tried once on arrival: it backs off a minute first.
    expect(await recovery.reconcileUnmatchedEvents(new Date())).toBe(0);
    expect(
      await recovery.reconcileUnmatchedEvents(later(2 * 60_000)),
    ).toBeGreaterThanOrEqual(1);
    expect(await eventRow(id)).toMatchObject({
      status: 'PROCESSED',
      outcome: 'LINKED_BY_RECOVERY',
    });
    expect(await attemptOf(r)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await ordersOf(r)).toBe(1);
  });

  it("never links through another business's account, nor through forged metadata", async () => {
    const { r, intentId, attempt } = await lostResponse();
    intents.succeed(intentId);
    await recheck(r); // links the intent on ACCT_1 (waiting → paid later)
    const viaOther = await unmatchedEventFor(intentId, ACCT_B);
    const forged = await unmatchedEventFor('pi_ForgedM4a001', ACCT_1, {
      centerivo_payment_attempt_id: attempt.id,
      centerivo_tenant_id: T1,
    });
    await recovery.reconcileUnmatchedEvents(new Date());
    expect((await eventRow(viaOther))!.status).toBe('UNMATCHED');
    expect((await eventRow(forged))!.status).toBe('UNMATCHED');
    expect((await attemptOf(r)).providerReference).toBe(intentId);
  });

  it('events still backing off never starve one that is due', async () => {
    const { r, intentId } = await lostResponse();
    await prisma.paymentAttempt.update({
      where: { id: (await attemptOf(r)).id },
      data: {
        providerReference: intentId,
        paymentState: 'REQUIRES_CUSTOMER_ACTION',
      },
    });
    // 25 older events, all tried a moment ago (backing off)...
    for (let i = 0; i < 25; i++) {
      await prisma.restaurantPaymentProviderEvent.create({
        data: {
          provider: 'stripe',
          externalEventId: evt(),
          type: 'payment_intent.requires_action',
          livemode: false,
          externalAccountId: ACCT_1,
          externalObjectId: intentId,
          payloadDigest: '0'.repeat(64),
          status: 'UNMATCHED',
          attempts: 1,
          lastAttemptAt: new Date(),
          receivedAt: new Date(Date.now() - 60 * 60_000),
        },
      });
    }
    // ...and one never tried, received after all of them.
    const fresh = await unmatchedEventFor(intentId);
    await prisma.restaurantPaymentProviderEvent.update({
      where: {
        provider_externalEventId: {
          provider: 'stripe',
          externalEventId: fresh,
        },
      },
      // As it arrived before its payment named the intent: never tried.
      data: {
        status: 'UNMATCHED',
        processedAt: null,
        attempts: 0,
        lastAttemptAt: null,
      },
    });
    expect(await recovery.reconcileUnmatchedEvents(new Date())).toBe(1);
    expect(await eventRow(fresh)).toMatchObject({
      status: 'PROCESSED',
      outcome: 'LINKED_BY_RECOVERY',
    });
  });

  // --- review fixes ----------------------------------------------------------------

  it('a webhook for a HELD payment whose intent is known reads Stripe back (never "settled" on the stored state)', async () => {
    const { r, intentId } = await crashedAfterAnswer('UNKNOWN');
    intents.succeed(intentId);
    const deliver = async (id: string) =>
      events.handle(
        provider.verifyPaymentEvent(
          signedPaymentEvent(stripe, {
            id,
            type: 'payment_intent.succeeded',
            account: ACCT_1,
            intent: {
              id: intentId,
              metadata: { centerivo_payment_attempt_id: 'x' },
            },
          }),
        ),
      );
    // Stripe unreadable: the event is NOT acknowledged and the payment stays.
    intents.retrieveError = stripeError('StripeAPIError', undefined, 500);
    const id = evt();
    expect(await deliver(id)).toBe(false);
    expect((await eventRow(id))!.status).toBe('FAILED');
    expect(await attemptOf(r)).toMatchObject({
      status: 'PENDING',
      paymentState: 'UNKNOWN',
    });
    // Readable: paid, one order, then the event is finished.
    expect(await deliver(id)).toBe(true);
    expect((await eventRow(id))!.status).toBe('PROCESSED');
    expect(await attemptOf(r)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await ordersOf(r)).toBe(1);
  });

  it('paid but its order not created yet is NOT reported settled (an unmatched event stays open); fulfilment recovery then creates it once', async () => {
    const { r, intentId } = await crashedAfterAnswer('UNKNOWN');
    intents.succeed(intentId);
    const spy = jest
      .spyOn(checkout, 'reconcileProviderPayment')
      .mockResolvedValueOnce('retry');
    try {
      expect(await recheck(r)).toEqual({
        kind: 'failed',
        failure: 'STRIPE_FULFILMENT_PENDING',
        retryable: true,
      });
    } finally {
      spy.mockRestore();
    }
    expect(await attemptOf(r)).toMatchObject({
      status: 'SUCCEEDED',
      paymentState: 'SUCCEEDED',
    });
    expect(await ordersOf(r)).toBe(0);
    const recovered = await recovery.recoverOne((await attemptOf(r)).id, T1, {
      trigger: 'automatic',
    });
    expect(recovered.kind).toBe('recovered');
    expect(await ordersOf(r)).toBe(1);
  });

  it('a replay answering with an intent for ANOTHER amount is never linked (set aside, holds kept)', async () => {
    const r = { ...body(), couponCode: await coupon() };
    intents.createAmountOverride = 1; // Stripe "created" it for 1 cent...
    intents.loseNextCreateResponse = true; // ...and the answer was lost.
    expect(await outcomeOf(() => submit(r))).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(await attemptOf(r)).toMatchObject({
      paymentState: 'UNKNOWN',
      providerReference: null,
    });
    expect(await recheck(r)).toEqual({
      kind: 'failed',
      failure: 'STRIPE_IDEMPOTENCY_CONFLICT',
      retryable: false,
    });
    expect((await attemptOf(r)).providerReference).toBeNull();
    expect(await holds(r, 'ACTIVE')).toBe(1);
  });

  it('a held payment whose intent is FOR another amount is never made live again', async () => {
    const r = { ...body(), couponCode: await coupon() };
    intents.createAmountOverride = 1;
    expect(await outcomeOf(() => submit(r))).toMatchObject({
      ok: false,
      status: 409,
    });
    const attempt = await attemptOf(r);
    // M3: the mismatched answer is held as UNKNOWN, its intent kept.
    expect(attempt).toMatchObject({ paymentState: 'UNKNOWN' });
    expect(attempt.providerReference).toMatch(/^pi_/);
    expect(await recheck(r)).toEqual({
      kind: 'failed',
      failure: 'STRIPE_AMOUNT_MISMATCH',
      retryable: false,
    });
    expect(await attemptOf(r)).toMatchObject({
      status: 'PENDING',
      paymentState: 'UNKNOWN',
    });
    expect(await holds(r, 'ACTIVE')).toBe(1);
  });

  // --- the sweep and support -----------------------------------------------------

  it('the sweep recovers a held payment end to end: read back, then the order exactly once', async () => {
    const { r, intentId } = await crashedAfterAnswer('UNKNOWN');
    intents.succeed(intentId);
    const swept = await recovery.sweep(later(RECOVERY_GRACE_MS + 60_000));
    expect(swept.swept).toBe(true);
    expect(await attemptOf(r)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await ordersOf(r)).toBe(1);
  });

  it('"Recheck with Stripe" runs the same path, keeps the reason as a note and is audited; never counted as automatic', async () => {
    const { r, intentId } = await crashedAfterAnswer('UNKNOWN');
    intents.cancel(intentId);
    const operator = await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:m4a-${run}`,
        email: `m4a-${run}@example.test`,
        status: 'ACTIVE',
      },
    });
    await prisma.paymentReconciliationCase.create({
      data: {
        tenantId: T1,
        paymentAttemptId: (await attemptOf(r)).id,
        reasonCode: 'PROVIDER_OUTCOME_UNKNOWN',
      },
    });
    const kase = (await caseOf(r))!;
    const answer = await cases.recheck(
      kase.id,
      'Customer asked whether they were charged',
      operator,
      'req-m4a',
    );
    expect(answer.result).toBe('NOT_CHARGED');
    expect(answer.detail.case.status).toBe('RESOLVED');
    expect(
      await prisma.paymentReconciliationNote.count({
        where: {
          caseId: kase.id,
          body: { startsWith: 'Stripe recheck requested:' },
        },
      }),
    ).toBe(1);
    expect(
      await prisma.platformAuditEvent.count({
        where: {
          action: 'platform.payment_case.stripe_recheck_requested',
          outcome: 'SUCCEEDED',
          reasonCode: 'NOT_CHARGED',
          targetId: kase.id,
          actorPlatformOperatorId: operator.id,
        },
      }),
    ).toBe(1);
    const started = (await caseOf(r))!.events.filter(
      (e) => e.action === 'STRIPE_RECHECK_STARTED',
    );
    expect(
      started.map((e) => (e.detail as { trigger: string }).trigger),
    ).toEqual(['platform_support']);
    // A resolved case is refused (audited), nothing more written.
    await expect(
      cases.recheck(
        kase.id,
        'Again, to be sure it is closed',
        operator,
        undefined,
      ),
    ).rejects.toMatchObject({
      status: 409,
    });
  });
});
