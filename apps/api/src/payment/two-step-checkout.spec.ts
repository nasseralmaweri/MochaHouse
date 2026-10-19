import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  createTestTenantB,
  removePaymentRecoveryRecordsForTest,
  removeTestTenantB,
  TEST_TENANT_B_ID,
  tenantContextFor,
} from '@mocha-house/testing';
import {
  FakePaymentProvider,
  FakeTwoStepPaymentProvider,
} from '@mocha-house/integrations';
import {
  CHECKOUT_NO_PAYMENT_IN_PROGRESS,
  CHECKOUT_RESOURCE_UNAVAILABLE,
  CHECKOUT_SESSION_INVALID,
  PAYMENT_SIMULATION_NOT_AVAILABLE,
  type CheckoutPaymentSimulationOutcome,
  type CheckoutSubmitResult,
} from '@mocha-house/contracts';
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
import type { CustomerIdentity } from '../customer-auth/infrastructure/customer-identity';
import {
  attemptsOfCheckout,
  checkoutAttemptsOfThisSuite,
  checkoutSessionsOfThisSuite,
  checkoutTokenFor,
  knownCheckoutToken,
  type LabelledCheckoutRequest,
} from '../../test/checkout-session';

// ESP-04 M2 — two-step (payment intent) checkout. Real services and a real
// disposable database; the provider is the development two-step fake, whose
// simulator plays the customer's part. Covers: intent creation and replay;
// reloads and interrupted responses resuming the same intent; the server
// reading the outcome from the provider (never the browser); a refused
// payment method retried on the same intent; processing and unknown
// outcomes; a confirmed cancellation; the financial-hold lifecycle;
// concurrent checks and submissions; exactly-once orders; zero-charge
// orders; tenant and customer isolation; the database safeguards of the new
// state; and the development simulator's restrictions.

async function outcomeOf<T>(fn: () => Promise<T>): Promise<{
  ok: boolean;
  value?: T;
  status?: number;
  response?: unknown;
}> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const err = e as { getStatus?: () => number; getResponse?: () => unknown };
    return {
      ok: false,
      status: err.getStatus?.(),
      response: err.getResponse?.(),
    };
  }
}

const codeOf = (r: { response?: unknown }) =>
  (r.response as { code?: string } | undefined)?.code;

jest.setTimeout(240_000);

describe('ESP-04 M2 two-step checkout (integration)', () => {
  let provider = new FakeTwoStepPaymentProvider();
  const t1 = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  const suffix = randomUUID().slice(0, 8);
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let checkout: CheckoutService;
  let locationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;
  const originalEnv = { ...process.env };
  const promotions: string[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
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
      .useFactory({ factory: () => provider })
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
    const group = product.modifierGroups[0].modifierGroup;
    sizeGroupId = group.id;
    mediumOptionId = group.options.find((o) => o.name === 'Medium')!.id;
    await createTestTenantB(prisma);
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
        externalSubject: { startsWith: `test-customer-m2-${suffix}` },
      },
    });
    await removeTestTenantB(prisma);
    await moduleRef.close();
    process.env = { ...originalEnv };
  });

  beforeEach(() => {
    provider.failNext = null;
    provider.createCalls = 0;
    provider.misreportSucceededAmount = null;
  });

  const caseOf = async (request: LabelledCheckoutRequest) => {
    const [attempt] = await attemptsOf(request);
    return prisma.paymentReconciliationCase.findFirst({
      where: { paymentAttemptId: attempt.id },
      select: { status: true, reasonCode: true, resolution: true },
    });
  };

  // --- fixtures ------------------------------------------------------------------

  const body = (
    overrides: Partial<LabelledCheckoutRequest> = {},
  ): LabelledCheckoutRequest => ({
    clientRef: `m2_${randomUUID()}`,
    locationId,
    guest: { name: 'Two Step Guest', phone: '5551237777' },
    lines: [
      {
        productId,
        quantity: 2,
        selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
      },
    ],
    ...overrides,
  });

  async function tokenOf(
    request: LabelledCheckoutRequest,
    identity?: CustomerIdentity,
  ): Promise<string> {
    return checkoutTokenFor(
      checkout,
      request.clientRef,
      locationId,
      identity,
      t1,
    );
  }

  async function submit(
    request: LabelledCheckoutRequest,
    identity?: CustomerIdentity,
  ): Promise<CheckoutSubmitResult> {
    const checkoutToken = await tokenOf(request, identity);
    const { locationId: at, guest, lines, couponCode } = request;
    return checkout.submit(
      { locationId: at, guest, lines, couponCode, checkoutToken },
      identity,
      t1,
    );
  }

  async function check(
    request: LabelledCheckoutRequest,
    identity?: CustomerIdentity,
    tenant = t1,
  ): Promise<CheckoutSubmitResult> {
    const checkoutToken = await tokenOf(request, identity);
    return checkout.checkPayment(
      { locationId, checkoutToken },
      identity,
      tenant,
    );
  }

  async function simulate(
    request: LabelledCheckoutRequest,
    outcome: CheckoutPaymentSimulationOutcome,
    identity?: CustomerIdentity,
  ): Promise<void> {
    const checkoutToken = await tokenOf(request, identity);
    await checkout.simulatePayment(
      { locationId, checkoutToken, outcome },
      identity,
      t1,
    );
  }

  const attemptsOf = (request: LabelledCheckoutRequest) =>
    prisma.paymentAttempt.findMany({
      where: attemptsOfCheckout(request.clientRef),
      orderBy: { createdAt: 'asc' },
    });

  async function ordersOf(request: LabelledCheckoutRequest) {
    const attempts = await attemptsOf(request);
    return prisma.order.findMany({
      where: { paymentAttemptId: { in: attempts.map((a) => a.id) } },
    });
  }

  async function activeHoldsOf(request: LabelledCheckoutRequest) {
    const attempts = await attemptsOf(request);
    return prisma.financialHold.count({
      where: {
        paymentAttemptId: { in: attempts.map((a) => a.id) },
        status: 'ACTIVE',
      },
    });
  }

  async function coupon(total: number | null, discountValue = 100) {
    const code = `M2${randomUUID().slice(0, 8)}`.toUpperCase();
    const promotion = await prisma.promotion.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        name: `M2 coupon ${code}`,
        kind: 'COUPON',
        code,
        discountType: 'FIXED_AMOUNT',
        discountValue,
        appliesToAllLocations: true,
        totalRedemptionLimit: total,
      },
    });
    promotions.push(promotion.id);
    return code;
  }

  async function member(): Promise<CustomerIdentity> {
    const identity = {
      provider: 'test' as const,
      subject: `test-customer-m2-${suffix}-${randomUUID()}`,
      email: `m2-${randomUUID().slice(0, 8)}@example.com`,
      name: null,
      emailVerified: null,
    };
    await prisma.customer.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        externalProvider: identity.provider,
        externalSubject: identity.subject,
        email: identity.email,
      },
    });
    return identity;
  }

  function paymentOf(result: CheckoutSubmitResult) {
    if (result.outcome !== 'PAYMENT_REQUIRED') {
      throw new Error(`expected PAYMENT_REQUIRED, got ${result.outcome}`);
    }
    return result.payment;
  }

  // --- intent creation and replay ------------------------------------------------

  it('creates one intent for the frozen amount and answers PAYMENT_REQUIRED (nothing fulfilled)', async () => {
    const request = body();
    const result = await submit(request);
    const payment = paymentOf(result);
    expect(payment.provider).toBe('fake-two-step');
    expect(payment.state).toBe('REQUIRES_CUSTOMER_ACTION');
    expect(payment.clientSecret).toBeNull();
    expect(payment.amountMinorUnits).toBeGreaterThan(0);
    expect(provider.createCalls).toBe(1);

    const [attempt] = await attemptsOf(request);
    expect(attempt).toMatchObject({
      status: 'PENDING',
      paymentState: 'REQUIRES_CUSTOMER_ACTION',
      amount: payment.amountMinorUnits,
    });
    expect(attempt.providerReference).toMatch(/^fakepi_/);
    expect(await ordersOf(request)).toHaveLength(0);
    expect(
      await prisma.checkoutSnapshot.count({
        where: { paymentAttemptId: attempt.id },
      }),
    ).toBe(1);
  });

  it('a retry, a reload and a lost response resume the SAME intent (never a second one)', async () => {
    const request = body();
    paymentOf(await submit(request));
    const [first] = await attemptsOf(request);

    // The response was lost: the same checkout is submitted again.
    paymentOf(await submit(request));
    // The page was reloaded: the session reports the waiting payment.
    const session = await checkout.startSession(
      { locationId, checkoutToken: knownCheckoutToken(request.clientRef) },
      undefined,
      t1,
    );
    expect(session.state).toBe('PAYMENT_REQUIRED');
    expect(session.checkoutToken).toBe(knownCheckoutToken(request.clientRef));
    // ...and checks where the payment stands.
    paymentOf(await check(request));

    const attempts = await attemptsOf(request);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].providerReference).toBe(first.providerReference);
    expect(provider.createCalls).toBe(1);
  });

  it('an unreachable provider at creation is held as UNKNOWN (never retried, never a new intent)', async () => {
    const request = body();
    provider.failNext = 'create';
    const first = await outcomeOf(() => submit(request));
    expect(first).toMatchObject({ ok: false, status: 409 });
    const [attempt] = await attemptsOf(request);
    expect(attempt).toMatchObject({
      status: 'PENDING',
      paymentState: 'UNKNOWN',
    });

    const retry = await outcomeOf(() => submit(request));
    expect(retry).toMatchObject({ ok: false, status: 409 });
    expect(provider.createCalls).toBe(1);
    expect(await attemptsOf(request)).toHaveLength(1);
  });

  // --- the outcome comes from the provider ---------------------------------------

  it('a successful confirmation creates the order exactly once (re-checks replay it)', async () => {
    const request = body();
    paymentOf(await submit(request));
    // The browser claiming success changes nothing: only the provider does.
    paymentOf(await check(request));
    expect(await ordersOf(request)).toHaveLength(0);

    await simulate(request, 'succeed');
    const done = await check(request);
    expect(done.outcome).toBe('COMPLETED');
    const again = await check(request);
    const resubmitted = await submit(request);
    expect(again).toEqual(done);
    expect(resubmitted).toEqual(done);

    const [attempt] = await attemptsOf(request);
    expect(attempt).toMatchObject({
      status: 'SUCCEEDED',
      paymentState: 'SUCCEEDED',
    });
    expect(await ordersOf(request)).toHaveLength(1);
    expect(provider.createCalls).toBe(1);
  });

  it('a refused payment method is NOT a failure: same intent, holds kept, then it can succeed', async () => {
    const code = await coupon(1);
    const request = body({ couponCode: code });
    paymentOf(await submit(request));
    const holdsBefore = await activeHoldsOf(request);
    expect(holdsBefore).toBeGreaterThan(0);

    await simulate(request, 'decline');
    const declined = paymentOf(await check(request));
    expect(declined.state).toBe('REQUIRES_PAYMENT_METHOD');
    const [attempt] = await attemptsOf(request);
    expect(attempt).toMatchObject({
      status: 'PENDING',
      paymentState: 'REQUIRES_CUSTOMER_ACTION',
    });
    expect(await activeHoldsOf(request)).toBe(holdsBefore);

    await simulate(request, 'succeed');
    expect((await check(request)).outcome).toBe('COMPLETED');
    expect(await attemptsOf(request)).toHaveLength(1);
    expect(await ordersOf(request)).toHaveLength(1);
    // Consumed by the order, never released.
    expect(await activeHoldsOf(request)).toBe(0);
    expect(
      await prisma.financialHold.count({
        where: { paymentAttemptId: attempt.id, status: 'RELEASED' },
      }),
    ).toBe(0);
  });

  it('processing is held and visible (holds kept, never a prompt to pay again); unknown changes nothing', async () => {
    const code = await coupon(1);
    const request = body({ couponCode: code });
    paymentOf(await submit(request));
    const holds = await activeHoldsOf(request);

    await simulate(request, 'process');
    const processing = paymentOf(await check(request));
    expect(processing.state).toBe('PROCESSING');
    expect(processing.clientSecret).toBeNull();
    expect((await attemptsOf(request))[0]).toMatchObject({
      status: 'PENDING',
      paymentState: 'AWAITING_CONFIRMATION',
    });
    expect(await caseOf(request)).toMatchObject({
      status: 'OPEN',
      reasonCode: 'PROVIDER_AWAITING_CONFIRMATION',
    });
    // A reload resumes it: the session reports it, the check reads it again.
    const session = await checkout.startSession(
      { locationId, checkoutToken: knownCheckoutToken(request.clientRef) },
      undefined,
      t1,
    );
    expect(session.state).toBe('PAYMENT_REQUIRED');
    expect(paymentOf(await check(request)).state).toBe('PROCESSING');
    expect(paymentOf(await submit(request)).state).toBe('PROCESSING');
    expect(provider.createCalls).toBe(1);

    await simulate(request, 'unknown');
    const unknown = await outcomeOf(() => check(request));
    expect(unknown).toMatchObject({ ok: false, status: 409 });

    provider.failNext = 'retrieve';
    const outage = await outcomeOf(() => check(request));
    expect(outage).toMatchObject({ ok: false, status: 409 });

    const [attempt] = await attemptsOf(request);
    expect(attempt).toMatchObject({
      status: 'PENDING',
      paymentState: 'AWAITING_CONFIRMATION',
    });
    expect(await activeHoldsOf(request)).toBe(holds);
    expect(await ordersOf(request)).toHaveLength(0);

    // The processing payment later succeeds: exactly one order, and the case
    // is resolved by it.
    await simulate(request, 'succeed');
    expect((await check(request)).outcome).toBe('COMPLETED');
    expect(await ordersOf(request)).toHaveLength(1);
    expect(await caseOf(request)).toMatchObject({
      status: 'RESOLVED',
      resolution: 'FULFILLED',
    });
  });

  it('a processing payment that is then cancelled releases its holds and resolves its case as NOT_CHARGED', async () => {
    const code = await coupon(1);
    const request = body({ couponCode: code });
    paymentOf(await submit(request));
    await simulate(request, 'process');
    paymentOf(await check(request));
    expect(await activeHoldsOf(request)).toBeGreaterThan(0);

    await simulate(request, 'cancel');
    expect(await outcomeOf(() => check(request))).toMatchObject({
      ok: false,
      status: 402,
    });
    expect((await attemptsOf(request))[0]).toMatchObject({
      status: 'FAILED',
      paymentState: 'FAILED',
    });
    expect(await activeHoldsOf(request)).toBe(0);
    expect(await caseOf(request)).toMatchObject({
      status: 'RESOLVED',
      resolution: 'NOT_CHARGED',
    });
  });

  it('a success for a different amount is never recorded as paid: held for people', async () => {
    const request = body();
    const payment = paymentOf(await submit(request));
    await simulate(request, 'succeed');
    provider.misreportSucceededAmount = payment.amountMinorUnits + 1;

    expect(await outcomeOf(() => check(request))).toMatchObject({
      ok: false,
      status: 409,
    });
    expect((await attemptsOf(request))[0]).toMatchObject({
      status: 'PENDING',
      paymentState: 'REQUIRES_CUSTOMER_ACTION',
    });
    expect(await ordersOf(request)).toHaveLength(0);
    expect(await caseOf(request)).toMatchObject({
      status: 'OPEN',
      reasonCode: 'PROVIDER_AMOUNT_MISMATCH',
    });
  });

  it('a confirmed cancellation fails the payment, releases its holds and lets the checkout be placed again', async () => {
    const code = await coupon(1);
    const request = body({ couponCode: code });
    paymentOf(await submit(request));
    expect(await activeHoldsOf(request)).toBeGreaterThan(0);

    await simulate(request, 'cancel');
    const cancelled = await outcomeOf(() => check(request));
    expect(cancelled).toMatchObject({ ok: false, status: 402 });

    const [attempt] = await attemptsOf(request);
    expect(attempt).toMatchObject({ status: 'FAILED', paymentState: 'FAILED' });
    expect(await activeHoldsOf(request)).toBe(0);
    expect(
      await prisma.checkoutSnapshot.count({
        where: { paymentAttemptId: attempt.id },
      }),
    ).toBe(0);
    // Checking again keeps answering the definitive outcome.
    expect(await outcomeOf(() => check(request))).toMatchObject({
      ok: false,
      status: 402,
    });

    // The same checkout may now be placed again: a NEW intent.
    paymentOf(await submit(request));
    expect(await attemptsOf(request)).toHaveLength(2);
    expect(provider.createCalls).toBe(2);
  });

  // --- financial holds -----------------------------------------------------------

  it('a waiting payment keeps its holds: a competing checkout cannot take the last redemption', async () => {
    const code = await coupon(1);
    const first = body({ couponCode: code });
    paymentOf(await submit(first));

    const competing = await outcomeOf(() => submit(body({ couponCode: code })));
    // Refused before any payment: at pricing (the redemption limit counts
    // active holds) or at reservation.
    expect(competing.ok).toBe(false);
    expect([400, 409]).toContain(competing.status);
    if (competing.status === 409) {
      expect(codeOf(competing)).toBe(CHECKOUT_RESOURCE_UNAVAILABLE);
    }

    // Released only when no charge can occur any more.
    await simulate(first, 'cancel');
    await outcomeOf(() => check(first));
    paymentOf(await submit(body({ couponCode: code })));
  });

  // --- concurrency ---------------------------------------------------------------

  it('concurrent checks of a paid intent create exactly one order', async () => {
    const request = body();
    paymentOf(await submit(request));
    await simulate(request, 'succeed');

    const results = await Promise.all(
      Array.from({ length: 6 }, () => outcomeOf(() => check(request))),
    );
    const completed = results.filter(
      (r) => r.ok && r.value?.outcome === 'COMPLETED',
    );
    expect(completed.length).toBeGreaterThan(0);
    // Any that did not complete were told to wait — never a failure.
    for (const r of results) {
      if (!r.ok) expect(r.status).toBe(409);
    }
    const orderIds = new Set(
      completed.map((r) =>
        r.value?.outcome === 'COMPLETED' ? r.value.confirmation.orderId : null,
      ),
    );
    expect(orderIds.size).toBe(1);
    expect(await ordersOf(request)).toHaveLength(1);
    expect((await check(request)).outcome).toBe('COMPLETED');
  });

  it('concurrent submissions of one checkout create one attempt and one intent', async () => {
    const request = body();
    await tokenOf(request);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => outcomeOf(() => submit(request))),
    );
    for (const r of results) {
      if (r.ok) expect(r.value?.outcome).toBe('PAYMENT_REQUIRED');
      else expect(r.status).toBe(409);
    }
    expect(results.some((r) => r.ok)).toBe(true);
    expect(await attemptsOf(request)).toHaveLength(1);
    expect(provider.createCalls).toBe(1);
  });

  // --- zero-charge ---------------------------------------------------------------

  it('a zero-charge order completes in one step without creating an intent', async () => {
    const code = await coupon(null, 1_000_000);
    const request = body({ couponCode: code });
    const result = await submit(request);
    expect(result.outcome).toBe('COMPLETED');
    expect(provider.createCalls).toBe(0);
    const [attempt] = await attemptsOf(request);
    expect(attempt).toMatchObject({
      status: 'SUCCEEDED',
      providerReference: 'no-charge',
      amount: 0,
    });
  });

  // --- isolation -----------------------------------------------------------------

  it("another business, another customer or a guest cannot check or simulate someone else's payment", async () => {
    const identity = await member();
    const request = body();
    paymentOf(await submit(request, identity));
    const checkoutToken = knownCheckoutToken(request.clientRef)!;

    // As a guest (no sign-in).
    const asGuest = await outcomeOf(() =>
      checkout.checkPayment({ locationId, checkoutToken }, undefined, t1),
    );
    expect(asGuest).toMatchObject({ ok: false, status: 409 });
    expect(codeOf(asGuest)).toBe(CHECKOUT_SESSION_INVALID);
    // As another customer.
    const other = await member();
    const asOther = await outcomeOf(() =>
      checkout.checkPayment({ locationId, checkoutToken }, other, t1),
    );
    expect(asOther.ok).toBe(false);
    // From another business.
    const tB = tenantContextFor(TEST_TENANT_B_ID);
    const asTenantB = await outcomeOf(() =>
      checkout.checkPayment({ locationId, checkoutToken }, undefined, tB),
    );
    expect(asTenantB.ok).toBe(false);
    expect([404, 409]).toContain(asTenantB.status);
    const simulateAsGuest = await outcomeOf(() =>
      checkout.simulatePayment(
        { locationId, checkoutToken, outcome: 'succeed' },
        undefined,
        t1,
      ),
    );
    expect(simulateAsGuest.ok).toBe(false);

    // Nothing moved; the owner can still complete it.
    const [attempt] = await attemptsOf(request);
    expect(attempt.paymentState).toBe('REQUIRES_CUSTOMER_ACTION');
    await simulate(request, 'succeed', identity);
    expect((await check(request, identity)).outcome).toBe('COMPLETED');
  });

  it('an intent that belongs to another business is never read as this payment', async () => {
    const request = body();
    paymentOf(await submit(request));
    const [attempt] = await attemptsOf(request);
    // A row pointing at an intent of another business: the provider will not
    // answer for it under this business's account, so nothing moves.
    const foreign = await provider.createPaymentIntent({
      idempotencyKey: `m2-foreign-${randomUUID()}`,
      amount: attempt.amount,
      currency: attempt.currency,
      account: { tenantId: TEST_TENANT_B_ID, connectedAccountId: null },
    });
    if (foreign.status !== 'requires_customer_action') throw new Error();
    provider.simulate(foreign.reference, TEST_TENANT_B_ID, 'succeed');
    await prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: { providerReference: foreign.reference },
    });
    expect(await outcomeOf(() => check(request))).toMatchObject({
      ok: false,
      status: 409,
    });
    const [after] = await attemptsOf(request);
    expect(after).toMatchObject({
      status: 'PENDING',
      paymentState: 'REQUIRES_CUSTOMER_ACTION',
    });
    expect(await ordersOf(request)).toHaveLength(0);
  });

  it('checking a checkout that never started a payment is refused', async () => {
    const request = body();
    await tokenOf(request);
    const result = await outcomeOf(() => check(request));
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(codeOf(result)).toBe(CHECKOUT_NO_PAYMENT_IN_PROGRESS);
  });

  // --- database safeguards -------------------------------------------------------

  it('the database refuses a waiting payment without its intent, or one that is not live', async () => {
    const request = body();
    paymentOf(await submit(request));
    const [attempt] = await attemptsOf(request);
    await expect(
      prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { providerReference: null },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { status: 'SUCCEEDED' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { paymentState: 'NOT_A_STATE' },
      }),
    ).rejects.toThrow();
  });

  // --- the development simulator -------------------------------------------------

  describe('development simulator restrictions', () => {
    it('is refused in a production-like environment', async () => {
      const request = body();
      paymentOf(await submit(request));
      process.env.APP_ENV = 'staging';
      try {
        const refused = await outcomeOf(() => simulate(request, 'succeed'));
        expect(refused).toMatchObject({ ok: false, status: 404 });
        expect(codeOf(refused)).toBe(PAYMENT_SIMULATION_NOT_AVAILABLE);
      } finally {
        delete process.env.APP_ENV;
      }
      expect((await attemptsOf(request))[0].paymentState).toBe(
        'REQUIRES_CUSTOMER_ACTION',
      );
    });

    it('is refused unless the two-step fake provider is configured', async () => {
      const request = body();
      paymentOf(await submit(request));
      const twoStep = provider;
      const service = checkout as unknown as { paymentProvider: unknown };
      service.paymentProvider = new FakePaymentProvider();
      try {
        const refused = await outcomeOf(() => simulate(request, 'succeed'));
        expect(refused).toMatchObject({ ok: false, status: 404 });
        expect(codeOf(refused)).toBe(PAYMENT_SIMULATION_NOT_AVAILABLE);
        // Without two-step payments configured the outcome cannot be read:
        // the payment is held, never treated as failed or paid.
        expect(await outcomeOf(() => check(request))).toMatchObject({
          ok: false,
          status: 409,
        });
      } finally {
        service.paymentProvider = twoStep;
        provider = twoStep;
      }
    });

    it('refuses an unsupported outcome and a checkout with nothing waiting', async () => {
      const request = body();
      await tokenOf(request);
      const checkoutToken = knownCheckoutToken(request.clientRef)!;
      const bad = await outcomeOf(() =>
        checkout.simulatePayment(
          {
            locationId,
            checkoutToken,
            outcome: 'refund' as CheckoutPaymentSimulationOutcome,
          },
          undefined,
          t1,
        ),
      );
      expect(bad).toMatchObject({ ok: false, status: 400 });
      const nothing = await outcomeOf(() => simulate(request, 'succeed'));
      expect(nothing).toMatchObject({ ok: false, status: 409 });
      expect(codeOf(nothing)).toBe(CHECKOUT_NO_PAYMENT_IN_PROGRESS);
    });

    it('cannot change a payment that already succeeded', async () => {
      const request = body();
      paymentOf(await submit(request));
      await simulate(request, 'succeed');
      expect((await check(request)).outcome).toBe('COMPLETED');
      const after = await outcomeOf(() => simulate(request, 'cancel'));
      expect(after).toMatchObject({ ok: false, status: 409 });
      expect((await check(request)).outcome).toBe('COMPLETED');
    });
  });
});
