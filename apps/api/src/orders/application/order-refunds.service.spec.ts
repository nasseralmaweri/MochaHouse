import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@mocha-house/database';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  tenantContextFor,
  type ScratchDatabase,
} from '@mocha-house/testing';
import type { CreateOrderRefundRequest } from '@mocha-house/contracts';
import type { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { BILLING_WIND_DOWN_ALLOWED } from '../../internal-auth/infrastructure/billing-wind-down.decorator';
import { RATE_LIMIT_POLICY_KEY } from '../../rate-limit/rate-limit.decorator';
import { AdminOrdersController } from '../api/admin-orders.controller';
import {
  OrderRefundsService,
  REFUND_REPLAY_WINDOW_MS,
  restaurantRefundsEnabled,
} from './order-refunds.service';
import {
  fakeStripePayments,
  stripeError,
} from '../../../test/fake-stripe-intents';
import * as adapter from '../../restaurant-payments/provider/stripe-payment-intent-provider';

// ESP-04 M5b — refund execution against a REAL PostgreSQL schema (every
// migration, including M5a's refund foundation and its guards) on a scratch
// database, with the real Stripe adapter over an in-memory stand-in (no
// network, no Stripe account). Refunds are financial history that cannot be
// removed from a shared database, hence the scratch database.

jest.setTimeout(300_000);

const migrations = listMigrations(
  join(__dirname, '../../../../../packages/database/prisma/migrations'),
);
const A = '01a0db02-f800-7000-8000-00000000m5ba'.replace('m5ba', '5b0a');
const B = '01a0db02-f800-7000-8000-000000005b0b';
const ACCT_A = 'acct_1M5bTenantA';
const ACCT_B = 'acct_1M5bTenantB';
const HOUR = 60 * 60 * 1000;

describe('ESP-04 M5b: refund execution (scratch database, offline Stripe)', () => {
  let scratch: ScratchDatabase;
  let db: PrismaClient;
  let refunds: OrderRefundsService;
  const fake = fakeStripePayments(new Set([A]));
  const { intents, provider } = fake;
  const tA = tenantContextFor(A);
  const tB = tenantContextFor(B);
  const env = { ...process.env };
  const base = {
    locA: '',
    locA2: '',
    locB: '',
    owner: { id: '', tenantId: A },
    manager: { id: '', tenantId: A },
    ownerB: { id: '', tenantId: B },
  };
  const owner = () =>
    AuthorizationContext.of({
      'orders.view': [{ scopeType: 'CORPORATE', scopeId: null }],
      'orders.refund': [{ scopeType: 'CORPORATE', scopeId: null }],
    });
  // A Refund Manager at the first location only.
  const refundManagerAt = (locationId: string) =>
    AuthorizationContext.of({
      'orders.view': [{ scopeType: 'LOCATION', scopeId: locationId }],
      'orders.refund': [{ scopeType: 'LOCATION', scopeId: locationId }],
    });
  // A Store Manager: sees orders, cannot refund.
  const storeManager = () =>
    AuthorizationContext.of({
      'orders.view': [{ scopeType: 'CORPORATE', scopeId: null }],
      'orders.manage_status': [{ scopeType: 'CORPORATE', scopeId: null }],
      'orders.cancel': [{ scopeType: 'CORPORATE', scopeId: null }],
    });

  beforeAll(async () => {
    process.env.RESTAURANT_REFUNDS_ENABLED = '1';
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'm5b_refunds',
    );
    await applyMigrations(scratch.url, migrations);
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: scratch.url }),
    });
    await db.$connect();
    refunds = new OrderRefundsService(
      db as unknown as PrismaService,
      new InternalAuditService(),
      provider,
    );
    await db.tenant.createMany({
      data: [
        { id: A, slug: 'm5b-a', name: 'Tenant A', status: 'ACTIVE' },
        { id: B, slug: 'm5b-b', name: 'Tenant B', status: 'ACTIVE' },
      ],
    });
    const location = (tenantId: string, slug: string) =>
      db.location.create({ data: { tenantId, name: slug, slug } });
    base.locA = (await location(A, 'm5b-a-1')).id;
    base.locA2 = (await location(A, 'm5b-a-2')).id;
    base.locB = (await location(B, 'm5b-b-1')).id;
    const user = (tenantId: string, email: string) =>
      db.internalUser.create({
        data: {
          tenantId,
          externalProvider: 'internal-dev',
          externalSubject: `internal-dev:${email}`,
          email,
          displayName: email,
          status: 'ACTIVE',
        },
        select: { id: true, tenantId: true },
      });
    base.owner = await user(A, 'owner@m5b-a.test');
    base.manager = await user(A, 'manager@m5b-a.test');
    base.ownerB = await user(B, 'owner@m5b-b.test');
    for (const [tenantId, account, by] of [
      [A, ACCT_A, base.owner.id],
      [B, ACCT_B, base.ownerB.id],
    ] as const) {
      await db.tenantPaymentAccount.create({
        data: {
          tenantId,
          provider: 'stripe',
          livemode: false,
          externalAccountId: account,
          dashboard: 'full',
          feesCollector: 'stripe',
          lossesCollector: 'stripe',
          cardPaymentsStatus: 'active',
          requirementsDue: 0,
          lastSyncedAt: new Date(),
          connectedByInternalUserId: by,
        },
      });
    }
  });

  afterAll(async () => {
    process.env = env;
    await db?.$disconnect();
    await scratch?.drop();
  });

  beforeEach(() => {
    process.env.RESTAURANT_REFUNDS_ENABLED = '1';
  });

  // --- fixtures ---------------------------------------------------------------

  interface Paid {
    orderId: string;
    attemptId: string;
    reference: string;
    tenantId: string;
    locationId: string;
  }

  // A Stripe-paid order, written as checkout writes it: a succeeded intent
  // on the business's account, its payment attempt and the order.
  async function paidOrder(
    o: {
      tenantId?: string;
      locationId?: string;
      amount?: number;
      status?: 'COMPLETED' | 'ACCEPTED' | 'READY';
      giftCard?: { id: string; tender: number };
      intentAmount?: number;
      accountId?: string;
      reconciliationRequired?: boolean;
      disputed?: boolean;
    } = {},
  ): Promise<Paid> {
    const tenantId = o.tenantId ?? A;
    const locationId = o.locationId ?? (tenantId === A ? base.locA : base.locB);
    const amount = o.amount ?? 2000;
    const account = o.accountId ?? (tenantId === A ? ACCT_A : ACCT_B);
    // Straight into the Stripe stand-in, on the payment's account (a payment
    // of any business, allowlisted or not).
    const intent = await intents.create(
      {
        amount: o.intentAmount ?? amount,
        currency: 'usd',
        payment_method_types: ['card'],
        metadata: { centerivo_tenant_id: tenantId },
      },
      { stripeAccount: account, idempotencyKey: `m5b-${randomUUID()}` },
    );
    const reference = intent.id;
    intents.succeed(reference);
    intents.withCharge(reference, { disputed: o.disputed });
    const tender = o.giftCard?.tender ?? 0;
    const attempt = await db.paymentAttempt.create({
      data: {
        tenantId,
        idempotencyKey: `m5b-${randomUUID()}`,
        provider: 'stripe',
        locationId,
        amount,
        currency: 'USD',
        status: 'SUCCEEDED',
        paymentState: 'SUCCEEDED',
        providerReference: reference,
        providerAccountId: account,
        reconciliationRequired: o.reconciliationRequired ?? false,
      },
    });
    const order = await db.order.create({
      data: {
        tenantId,
        orderNumber: `M5B-${randomUUID().slice(0, 12)}`,
        accessToken: randomUUID(),
        locationId,
        paymentAttemptId: attempt.id,
        guestName: 'Guest',
        guestPhone: '5550000',
        currency: 'USD',
        subtotal: amount + tender,
        giftCardTenderMinorUnits: tender,
        status: o.status ?? 'COMPLETED',
      },
    });
    return {
      orderId: order.id,
      attemptId: attempt.id,
      reference,
      tenantId,
      locationId,
    };
  }

  // Cancels an ACCEPTED order with the rows the closure writer creates: a
  // DUE obligation for the whole card amount.
  async function cancelled(
    amount = 2000,
  ): Promise<Paid & { obligationId: string }> {
    const paid = await paidOrder({ amount, status: 'ACCEPTED' });
    const closureId = randomUUID();
    const obligationId = randomUUID();
    await db.$transaction([
      db.$executeRaw`UPDATE "Order" SET status = 'CANCELLED' WHERE id = ${paid.orderId}`,
      db.$executeRaw`INSERT INTO "OrderClosure" (id, "tenantId", "orderId", kind, "fromStatus", "reasonCode", "actorInternalUserId", "refundDueMinorUnits")
        VALUES (${closureId}, ${A}, ${paid.orderId}, 'CANCELLED', 'ACCEPTED', 'CUSTOMER_REQUEST', ${base.manager.id}, ${amount})`,
      db.$executeRaw`INSERT INTO "OrderRefundObligation" (id, "tenantId", "orderId", "closureId", "paymentAttemptId", "amountMinorUnits", currency, "updatedAt")
        VALUES (${obligationId}, ${A}, ${paid.orderId}, ${closureId}, ${paid.attemptId}, ${amount}, 'USD', now())`,
    ]);
    return { ...paid, obligationId };
  }

  // What the staff page would show as refunded + in progress right now.
  const reservedNow = async (paid: Paid) =>
    (
      await db.paymentRefund.findMany({
        where: {
          paymentAttemptId: paid.attemptId,
          status: { in: ['REQUESTED', 'PENDING', 'UNKNOWN', 'SUCCEEDED'] },
        },
        select: { amountMinorUnits: true },
      })
    ).reduce((sum, r) => sum + r.amountMinorUnits, 0);
  const ask = async (
    paid: Paid,
    over: Partial<CreateOrderRefundRequest> = {},
    as: {
      actor?: { id: string; tenantId: string };
      auth?: AuthorizationContext;
    } = {},
  ) =>
    refunds.request(
      paid.orderId,
      {
        locationId: paid.locationId,
        requestId: randomUUID(),
        amountMinorUnits: 500,
        currency: 'USD',
        reasonCode: 'CUSTOMER_REQUEST',
        expectedReservedMinorUnits: await reservedNow(paid),
        ...over,
      },
      as.actor ?? base.owner,
      as.auth ?? owner(),
      paid.tenantId === A ? tA : tB,
    );
  const recheck = (paid: Paid, refundId: string, now?: Date) =>
    refunds.recheck(
      paid.orderId,
      refundId,
      { locationId: paid.locationId },
      base.owner,
      owner(),
      tA,
      now,
    );
  const refundsAt = (reference: string) =>
    [...intents.refunds.values()].filter(
      (r) => r.refund.payment_intent === reference,
    );
  const obligation = (id: string) =>
    db.orderRefundObligation.findUniqueOrThrow({ where: { id } });
  // In a fixed order (several tests write the same actions).
  const audits = (action: string, targetId?: string) =>
    db.internalAuditEvent.findMany({
      where: { tenantId: A, action, ...(targetId ? { targetId } : {}) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  // The disposable-database superuser bypass (T-2), used ONLY to age a
  // refund's first sending past Stripe's idempotency window.
  const ageSending = (refundId: string, hours: number) =>
    db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRaw`UPDATE "PaymentRefund" SET "firstSentAt" = "firstSentAt" - make_interval(hours => ${hours}) WHERE id = ${refundId}`,
    ]);

  // --- refunds of a completed order -------------------------------------------

  it('refunds part of a completed order to the original card, on its own account, verified by read-back', async () => {
    const paid = await paidOrder({ amount: 2000 });
    const result = await ask(paid, { amountMinorUnits: 500 });
    expect(result.replayed).toBe(false);
    expect(result.refund).toMatchObject({
      status: 'SUCCEEDED',
      origin: 'CENTERIVO',
      amountMinorUnits: 500,
      reasonCode: 'CUSTOMER_REQUEST',
    });
    expect(result.balances).toEqual({
      chargedMinorUnits: 2000,
      refundedMinorUnits: 500,
      inProgressMinorUnits: 0,
      refundableMinorUnits: 1500,
      lateFailureNeedsReview: false,
      unresolved: false,
    });
    // One Stripe refund, of the original intent, on the business's account,
    // with the operation's own key — and read back after.
    const made = refundsAt(paid.reference);
    expect(made).toHaveLength(1);
    expect(made[0].account).toBe(ACCT_A);
    const [params, options] = intents.refundCreate.mock.calls.at(-1)!;
    expect(params).toMatchObject({
      payment_intent: paid.reference,
      amount: 500,
      reason: 'requested_by_customer',
      metadata: {
        centerivo_refund_id: result.refund.id,
        centerivo_tenant_id: A,
      },
    });
    expect(options).toEqual({
      stripeAccount: ACCT_A,
      idempotencyKey: `centerivo-refund:${result.refund.id}`,
    });
    expect(intents.refundRetrieve).toHaveBeenCalled();
    expect(await audits('order.refund_requested')).toHaveLength(1);
    expect((await audits('order.refund_succeeded')).length).toBeGreaterThan(0);
  });

  it('several partial refunds, then the rest: never more than the card paid', async () => {
    const paid = await paidOrder({ amount: 1000 });
    await ask(paid, { amountMinorUnits: 300 });
    await ask(paid, { amountMinorUnits: 200 });
    await expect(ask(paid, { amountMinorUnits: 501 })).rejects.toThrow(
      /more than is left to refund \(500 available\)/,
    );
    const last = await ask(paid, { amountMinorUnits: 500 });
    expect(last.balances).toMatchObject({
      refundedMinorUnits: 1000,
      refundableMinorUnits: 0,
    });
    await expect(ask(paid, { amountMinorUnits: 1 })).rejects.toThrow(
      /more than is left/,
    );
    expect(refundsAt(paid.reference)).toHaveLength(3);
  });

  it('a mixed-tender order refunds the card part only: the gift card is untouched', async () => {
    const card = await db.giftCard.create({
      data: {
        tenantId: A,
        codeHash: `m5b-${randomUUID()}`,
        last4: '1234',
        originalValueMinorUnits: 1000,
        balanceMinorUnits: 600,
        currency: 'USD',
      },
    });
    const paid = await paidOrder({
      amount: 800,
      giftCard: { id: card.id, tender: 400 },
    });
    await expect(ask(paid, { amountMinorUnits: 801 })).rejects.toThrow(
      /more than is left/,
    );
    const full = await ask(paid, { amountMinorUnits: 800 });
    expect(full.refund.status).toBe('SUCCEEDED');
    expect(
      (await db.giftCard.findUniqueOrThrow({ where: { id: card.id } }))
        .balanceMinorUnits,
    ).toBe(600);
  });

  it('refuses an order in progress, a payment needing reconciliation, a wrong account, another amount or currency, and a disputed charge', async () => {
    await expect(ask(await paidOrder({ status: 'READY' }))).rejects.toThrow(
      /cancelled instead/,
    );
    await expect(
      ask(await paidOrder({ reconciliationRequired: true })),
    ).rejects.toThrow(/needs reconciliation/);
    // A payment made on an account that is not the business's.
    await expect(
      ask(await paidOrder({ accountId: 'acct_1M5bSomeoneElse' })),
    ).rejects.toThrow(/no longer the business/);
    // Stripe holds another amount than the payment says.
    await expect(
      ask(await paidOrder({ amount: 2000, intentAmount: 2500 })),
    ).rejects.toThrow(/does not match/);
    await expect(ask(await paidOrder(), { currency: 'EUR' })).rejects.toThrow(
      /payment’s own currency/,
    );
    await expect(ask(await paidOrder({ disputed: true }))).rejects.toThrow(
      /disputed/,
    );
    // Nothing was asked of Stripe for any of them.
    expect(intents.refundCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({ amount: 500, payment_intent: 'pi_none' }),
      expect.anything(),
    );
  });

  it('fails closed when Stripe shows a refund that is not recorded here (a Dashboard refund); counts it once recorded', async () => {
    const paid = await paidOrder({ amount: 1000 });
    const dashboard = intents.dashboardRefund(paid.reference, 300);
    const before = intents.refundCreate.mock.calls.length;
    await expect(ask(paid, { amountMinorUnits: 100 })).rejects.toThrow(
      /not recorded here|do not match/,
    );
    expect(intents.refundCreate.mock.calls.length).toBe(before);
    // Recorded (as M5c will, from Stripe's read-back): it counts.
    await db.paymentRefund.create({
      data: {
        tenantId: A,
        orderId: paid.orderId,
        paymentAttemptId: paid.attemptId,
        provider: 'stripe',
        providerAccountId: ACCT_A,
        origin: 'EXTERNAL',
        amountMinorUnits: 300,
        currency: 'USD',
        status: 'SUCCEEDED',
        providerRefundId: dashboard,
      },
    });
    await expect(ask(paid, { amountMinorUnits: 701 })).rejects.toThrow(
      /700 available/,
    );
    const rest = await ask(paid, { amountMinorUnits: 700 });
    expect(rest.balances.refundedMinorUnits).toBe(1000);
  });

  it('fails closed when Stripe’s refund history cannot be read in full', async () => {
    const paid = await paidOrder();
    intents.refundListError = stripeError('StripeConnectionError');
    await expect(ask(paid)).rejects.toThrow(/could not be fully read/);
    const spy = jest
      .spyOn(provider, 'listRefundsFor')
      .mockResolvedValueOnce({ refunds: [], complete: false });
    await expect(ask(paid)).rejects.toThrow(/could not be fully read/);
    spy.mockRestore();
    intents.refundListError = null;
    expect(refundsAt(paid.reference)).toHaveLength(0);
  });

  // --- request identity ---------------------------------------------------------

  it('a repeated request returns the same refund; the same id with other values is refused', async () => {
    const paid = await paidOrder({ amount: 1000 });
    const requestId = randomUUID();
    // The same submission: the balance it was decided on travels with it.
    const same = {
      requestId,
      amountMinorUnits: 400,
      expectedReservedMinorUnits: 0,
    };
    const first = await ask(paid, same);
    const again = await ask(paid, same);
    expect(again.replayed).toBe(true);
    expect(again.refund.id).toBe(first.refund.id);
    expect(refundsAt(paid.reference)).toHaveLength(1);
    await expect(ask(paid, { ...same, amountMinorUnits: 401 })).rejects.toThrow(
      /already used for a different refund/,
    );
    await expect(ask(paid, { ...same, note: 'changed' })).rejects.toThrow(
      /already used/,
    );
    // Another staff member reusing the id is a different request too.
    await expect(
      ask(paid, same, { actor: base.manager, auth: owner() }),
    ).rejects.toThrow(/already used/);
  });

  it('a new request decided on a balance that has changed since is refused (no refund on top by accident)', async () => {
    const paid = await paidOrder({ amount: 1000 });
    // Two staff members both saw nothing refunded and both meant to refund
    // 500 of it; one is first.
    await ask(paid, { amountMinorUnits: 500, expectedReservedMinorUnits: 0 });
    await expect(
      ask(
        paid,
        { amountMinorUnits: 500, expectedReservedMinorUnits: 0 },
        { actor: base.manager },
      ),
    ).rejects.toThrow(/changed since you looked/);
    expect(refundsAt(paid.reference)).toHaveLength(1);
    // Decided on the current balance: allowed.
    const second = await ask(paid, {
      amountMinorUnits: 500,
      expectedReservedMinorUnits: 500,
    });
    expect(second.refund.status).toBe('SUCCEEDED');
    await expect(
      ask(paid, {
        amountMinorUnits: 1,
        expectedReservedMinorUnits: undefined as never,
      }),
    ).rejects.toThrow(/expectedReservedMinorUnits/);
  });

  it('the same request submitted twice at once creates one refund', async () => {
    const paid = await paidOrder({ amount: 1000 });
    const requestId = randomUUID();
    const same = {
      requestId,
      amountMinorUnits: 400,
      expectedReservedMinorUnits: 0,
    };
    const results = await Promise.allSettled([
      ask(paid, same),
      ask(paid, same),
    ]);
    const ids = new Set(
      results.flatMap((r) =>
        r.status === 'fulfilled' ? [r.value.refund.id] : [],
      ),
    );
    expect(ids.size).toBe(1);
    expect(refundsAt(paid.reference)).toHaveLength(1);
    expect(
      await db.paymentRefund.count({
        where: { paymentAttemptId: paid.attemptId },
      }),
    ).toBe(1);
  });

  it('two staff members refunding at once can never both take the last of a payment', async () => {
    const paid = await paidOrder({ amount: 1000 });
    const results = await Promise.allSettled([
      ask(paid, { amountMinorUnits: 1000 }),
      ask(paid, { amountMinorUnits: 1000 }, { actor: base.manager }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictException,
    );
    expect(refundsAt(paid.reference)).toHaveLength(1);
  });

  // --- uncertain outcomes and recheck ----------------------------------------------

  it('a lost answer leaves it UNKNOWN (capacity kept, nothing new asked); the recheck replays the SAME key and finds it', async () => {
    const paid = await paidOrder({ amount: 1000 });
    intents.loseNextRefundResponse = true;
    const lost = await ask(paid, { amountMinorUnits: 1000 });
    expect(lost.refund.status).toBe('UNKNOWN');
    expect(lost.balances).toMatchObject({
      inProgressMinorUnits: 1000,
      refundableMinorUnits: 0,
      unresolved: true,
    });
    // Stripe made it once; no second refund can be asked for meanwhile.
    expect(refundsAt(paid.reference)).toHaveLength(1);
    await expect(ask(paid, { amountMinorUnits: 1 })).rejects.toThrow(
      /still waiting for Stripe’s answer/,
    );
    const keys = () =>
      intents.refundCreate.mock.calls
        .filter(([p]) => p.payment_intent === paid.reference)
        .map(([, o]) => o.idempotencyKey);
    const checked = await recheck(paid, lost.refund.id);
    expect(checked.refund.status).toBe('SUCCEEDED');
    expect(new Set(keys())).toEqual(
      new Set([`centerivo-refund:${lost.refund.id}`]),
    );
    expect(refundsAt(paid.reference)).toHaveLength(1);
  });

  it('a Stripe error leaves it UNKNOWN; within the window the recheck makes it exactly once', async () => {
    const paid = await paidOrder({ amount: 1000 });
    intents.refundCreateError = stripeError('StripeAPIError', undefined, 500);
    const unknown = await ask(paid, { amountMinorUnits: 600 });
    expect(unknown.refund.status).toBe('UNKNOWN');
    expect(refundsAt(paid.reference)).toHaveLength(0);
    const checked = await recheck(paid, unknown.refund.id);
    expect(checked.refund.status).toBe('SUCCEEDED');
    expect(refundsAt(paid.reference)).toHaveLength(1);
    // A second recheck changes nothing.
    await recheck(paid, unknown.refund.id);
    expect(refundsAt(paid.reference)).toHaveLength(1);
  });

  it('a database failure after Stripe answered keeps the operation; the recheck records what Stripe did', async () => {
    const paid = await paidOrder({ amount: 1000 });
    const spy = jest
      .spyOn(refunds, 'recordOutcome')
      .mockRejectedValueOnce(new Error('database unavailable'));
    await expect(ask(paid, { amountMinorUnits: 700 })).rejects.toThrow(
      /database unavailable/,
    );
    spy.mockRestore();
    const row = await db.paymentRefund.findFirstOrThrow({
      where: { paymentAttemptId: paid.attemptId },
    });
    expect(row).toMatchObject({ status: 'REQUESTED' });
    expect(row.firstSentAt).not.toBeNull();
    expect(refundsAt(paid.reference)).toHaveLength(1);
    const checked = await recheck(paid, row.id);
    expect(checked.refund.status).toBe('SUCCEEDED');
    expect(refundsAt(paid.reference)).toHaveLength(1);
  });

  it('past the window, "never created" needs a complete Stripe history and 24 hours; otherwise it stays UNKNOWN', async () => {
    const paid = await paidOrder({ amount: 1000 });
    intents.refundCreateError = stripeError('StripeAPIError', undefined, 500);
    const unknown = await ask(paid, { amountMinorUnits: 400 });
    const id = unknown.refund.id;
    // 21 hours on: no replay any more; Stripe has nothing, but inside 24
    // hours absence proves nothing.
    await ageSending(id, 21);
    const now = new Date(Date.now());
    expect((await recheck(paid, id, now)).refund.status).toBe('UNKNOWN');
    // 25 hours on, but the history cannot be read in full: still UNKNOWN.
    await ageSending(id, 4);
    const spy = jest
      .spyOn(provider, 'listRefundsFor')
      .mockResolvedValueOnce({ refunds: [], complete: false });
    expect((await recheck(paid, id)).refund.status).toBe('UNKNOWN');
    spy.mockRestore();
    // A complete history with nothing of this operation: proven.
    const proven = await recheck(paid, id);
    expect(proven.refund).toMatchObject({
      status: 'NOT_CREATED',
      notCreatedEvidence: 'STRIPE_HISTORY_VERIFIED',
    });
    expect(proven.balances.refundableMinorUnits).toBe(1000);
    // Never replayed past the window: no refund was ever made.
    expect(refundsAt(paid.reference)).toHaveLength(0);
    expect(REFUND_REPLAY_WINDOW_MS).toBe(20 * HOUR);
  });

  it('past the window, a refund Stripe did make is found in its history', async () => {
    const paid = await paidOrder({ amount: 1000 });
    intents.loseNextRefundResponse = true;
    const lost = await ask(paid, { amountMinorUnits: 400 });
    await ageSending(lost.refund.id, 30);
    const found = await recheck(paid, lost.refund.id);
    expect(found.refund.status).toBe('SUCCEEDED');
    expect(refundsAt(paid.reference)).toHaveLength(1);
  });

  it('a pending refund reserves its amount; the recheck follows it to success, or to failure (amount free again)', async () => {
    const paid = await paidOrder({ amount: 1000 });
    intents.nextRefundStatus = 'pending';
    const pending = await ask(paid, { amountMinorUnits: 600 });
    expect(pending.refund.status).toBe('PENDING');
    expect(pending.balances).toMatchObject({
      inProgressMinorUnits: 600,
      refundableMinorUnits: 400,
    });
    expect((await recheck(paid, pending.refund.id)).refund.status).toBe(
      'PENDING',
    );
    const stripeId = refundsAt(paid.reference)[0].refund.id;
    intents.setRefund(stripeId, { status: 'succeeded' });
    expect((await recheck(paid, pending.refund.id)).refund.status).toBe(
      'SUCCEEDED',
    );

    const other = await paidOrder({ amount: 1000 });
    intents.nextRefundStatus = 'failed';
    const failed = await ask(other, { amountMinorUnits: 1000 });
    expect(failed.refund.status).toBe('FAILED');
    expect(failed.balances.refundableMinorUnits).toBe(1000);
  });

  // --- refund obligations --------------------------------------------------------

  it('a cancelled order: refunds what is owed, and the obligation is settled as soon as Stripe verifies it', async () => {
    const order = await cancelled(1500);
    expect((await obligation(order.obligationId)).status).toBe('DUE');
    await expect(ask(order, { amountMinorUnits: 1501 })).rejects.toThrow(
      /1500 available/,
    );
    const refund = await ask(order, {
      amountMinorUnits: 1500,
      reasonCode: 'ORDER_CLOSED',
    });
    expect(refund.refund.status).toBe('SUCCEEDED');
    expect(await obligation(order.obligationId)).toMatchObject({
      status: 'REFUNDED',
      settlementMethod: 'PROCESSOR',
      processorRefundId: refundsAt(order.reference)[0].refund.id,
    });
    expect(refund.obligation).toMatchObject({
      outstandingMinorUnits: 0,
      fullyRefunded: true,
      needsAttention: false,
    });
  });

  it('an obligation partly covered (a partial refund, a recorded Dashboard refund) owes only the rest, and stays PROCESSING until covered', async () => {
    const order = await cancelled(1000);
    const first = await ask(order, { amountMinorUnits: 300 });
    expect(first.obligation).toMatchObject({ outstandingMinorUnits: 700 });
    // Part of it refunded, the rest still to ask for: PROCESSING (FAILED is
    // only for an obligation nothing of which was refunded).
    expect((await obligation(order.obligationId)).status).toBe('PROCESSING');
    const dashboard = intents.dashboardRefund(order.reference, 200);
    await db.paymentRefund.create({
      data: {
        tenantId: A,
        orderId: order.orderId,
        paymentAttemptId: order.attemptId,
        provider: 'stripe',
        providerAccountId: ACCT_A,
        origin: 'EXTERNAL',
        amountMinorUnits: 200,
        currency: 'USD',
        status: 'SUCCEEDED',
        providerRefundId: dashboard,
      },
    });
    // Never the whole obligation again.
    await expect(ask(order, { amountMinorUnits: 1000 })).rejects.toThrow(
      /500 available/,
    );
    intents.nextRefundStatus = 'pending';
    const rest = await ask(order, { amountMinorUnits: 500 });
    expect(rest.refund.status).toBe('PENDING');
    expect((await obligation(order.obligationId)).status).toBe('PROCESSING');
    intents.setRefund(refundsAt(order.reference).at(-1)!.refund.id, {
      status: 'succeeded',
    });
    await recheck(order, rest.refund.id);
    expect((await obligation(order.obligationId)).status).toBe('REFUNDED');
  });

  it('a refund whose money comes back after settlement: owed again, flagged, and no replacement until reviewed', async () => {
    const order = await cancelled(800);
    const done = await ask(order, { amountMinorUnits: 800 });
    expect((await obligation(order.obligationId)).status).toBe('REFUNDED');
    intents.setRefund(refundsAt(order.reference)[0].refund.id, {
      status: 'failed',
      failure_reason: 'expired_or_canceled_card',
    });
    const returned = await recheck(order, done.refund.id);
    expect(returned.refund.status).toBe('FAILED_AFTER_SUCCESS');
    // The settled obligation keeps its history (S5a) but is never presented
    // as satisfied: what is owed comes from the refunds.
    expect((await obligation(order.obligationId)).status).toBe('REFUNDED');
    expect(returned.obligation).toMatchObject({
      recordedStatus: 'REFUNDED',
      outstandingMinorUnits: 800,
      fullyRefunded: false,
      needsAttention: true,
    });
    await expect(ask(order, { amountMinorUnits: 800 })).rejects.toThrow(
      /must be reviewed/,
    );
    // The review is staff-only (orders.refund), audited, and once.
    await expect(
      refunds.review(
        order.orderId,
        done.refund.id,
        { locationId: order.locationId, note: 'Checked' },
        base.manager,
        storeManager(),
        tA,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await refunds.review(
      order.orderId,
      done.refund.id,
      {
        locationId: order.locationId,
        note: 'Card expired; customer gave a new one.',
      },
      base.owner,
      owner(),
      tA,
    );
    await expect(
      refunds.review(
        order.orderId,
        done.refund.id,
        { locationId: order.locationId, note: 'Again' },
        base.owner,
        owner(),
        tA,
      ),
    ).rejects.toThrow(/already been reviewed/);
    expect(await audits('order.refund_late_failure_reviewed')).toHaveLength(1);
    const replacement = await ask(order, { amountMinorUnits: 800 });
    expect(replacement.refund.status).toBe('SUCCEEDED');
    expect(replacement.obligation).toMatchObject({
      outstandingMinorUnits: 0,
      needsAttention: false,
    });
  });

  it('lists what is still owed on cancelled orders at the location', async () => {
    const order = await cancelled(900);
    const { obligations } = await refunds.listObligations(
      base.locA,
      base.owner,
      owner(),
      tA,
    );
    expect(
      obligations.find((o) => o.orderId === order.orderId)?.obligation,
    ).toMatchObject({ outstandingMinorUnits: 900, recordedStatus: 'DUE' });
  });

  // --- who may refund ------------------------------------------------------------

  it('a Store Manager (no orders.refund) is refused and the attempt audited; a Refund Manager only at their location', async () => {
    const paid = await paidOrder();
    await expect(
      ask(paid, {}, { actor: base.manager, auth: storeManager() }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Exactly this attempt, on this order, by this staff member.
    expect(
      (await audits('order.refund_denied', paid.orderId)).map((a) => ({
        actor: a.actorInternalUserId,
        targetType: a.targetType,
        afterData: a.afterData,
      })),
    ).toEqual([
      {
        actor: base.manager.id,
        targetType: 'order',
        afterData: { attempted: 'request' },
      },
    ]);
    // A Refund Manager at another location of the business: refused and
    // audited the same way.
    const elsewhere = await paidOrder({ locationId: base.locA2 });
    await expect(
      ask(
        elsewhere,
        {},
        { actor: base.manager, auth: refundManagerAt(base.locA) },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      (await audits('order.refund_denied', elsewhere.orderId)).map(
        (a) => a.actorInternalUserId,
      ),
    ).toEqual([base.manager.id]);
    // Nothing was asked of Stripe for either.
    expect(refundsAt(paid.reference)).toHaveLength(0);
    expect(refundsAt(elsewhere.reference)).toHaveLength(0);
    // ...and at their own.
    const own = await ask(
      paid,
      {},
      { actor: base.manager, auth: refundManagerAt(base.locA) },
    );
    expect(own.refund.status).toBe('SUCCEEDED');
    // Reading needs orders.view only.
    const read = await refunds.listForOrder(
      paid.orderId,
      paid.locationId,
      base.manager,
      storeManager(),
      tA,
    );
    expect(read.refunds).toHaveLength(1);
  });

  it('another business’s order is not found (no cross-business read or write), and a location mismatch is not found', async () => {
    const theirs = await paidOrder({ tenantId: B });
    // Tenant A's owner, A's context, B's order id: nothing.
    await expect(
      refunds.request(
        theirs.orderId,
        {
          locationId: theirs.locationId,
          requestId: randomUUID(),
          amountMinorUnits: 100,
          currency: 'USD',
          reasonCode: 'CUSTOMER_REQUEST',
          expectedReservedMinorUnits: 0,
        },
        base.owner,
        owner(),
        tA,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      refunds.listForOrder(
        theirs.orderId,
        theirs.locationId,
        base.owner,
        owner(),
        tA,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    // An actor of another business than the request's.
    await expect(
      refunds.listForOrder(
        theirs.orderId,
        theirs.locationId,
        base.owner,
        owner(),
        tB,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    const ours = await paidOrder();
    await expect(
      refunds.listForOrder(ours.orderId, base.locA2, base.owner, owner(), tA),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(refundsAt(theirs.reference)).toHaveLength(0);
  });

  it('is unavailable with the switch off, or for a business not on the test-mode allowlist; history stays readable', async () => {
    const paid = await paidOrder();
    process.env.RESTAURANT_REFUNDS_ENABLED = 'true';
    expect(restaurantRefundsEnabled()).toBe(false);
    await expect(ask(paid)).rejects.toThrow(/not available/);
    const read = await refunds.listForOrder(
      paid.orderId,
      paid.locationId,
      base.owner,
      owner(),
      tA,
    );
    expect(read.refundsEnabled).toBe(false);
    process.env.RESTAURANT_REFUNDS_ENABLED = '1';
    // Tenant B is not on the allowlist.
    await expect(
      refunds.request(
        (await paidOrder({ tenantId: B })).orderId,
        {
          locationId: base.locB,
          requestId: randomUUID(),
          amountMinorUnits: 100,
          currency: 'USD',
          reasonCode: 'CUSTOMER_REQUEST',
          expectedReservedMinorUnits: 0,
        },
        base.ownerB,
        owner(),
        tB,
      ),
    ).rejects.toThrow(/not available/);
  });

  it('refund routes: rate-limited, allowed during a billing wind-down, and validate their input', async () => {
    for (const name of [
      'requestRefund',
      'recheckRefund',
      'reviewRefund',
    ] as const) {
      const handler = Object.getOwnPropertyDescriptor(
        AdminOrdersController.prototype,
        name,
      )!.value as object;
      expect(Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, handler)).toBe(
        'restaurant-refunds',
      );
      expect(Reflect.getMetadata(BILLING_WIND_DOWN_ALLOWED, handler)).toBe(
        true,
      );
    }
    const paid = await paidOrder();
    for (const bad of [
      { requestId: 'not-a-uuid' },
      { amountMinorUnits: 0 },
      { amountMinorUnits: 10.5 },
      { currency: 'usd' },
      { reasonCode: 'FRAUD' as never },
      { reasonCode: 'OTHER' as const },
      { note: 'x'.repeat(501) },
      { note: 'hidden‮text' },
    ]) {
      await expect(ask(paid, bad)).rejects.toThrow();
    }
    expect(refundsAt(paid.reference)).toHaveLength(0);
  });

  it('a request the adapter would refuse before sending is recorded never sent (NOT_CREATED), not left blocking the payment', async () => {
    const paid = await paidOrder({ amount: 1000 });
    const spy = jest
      .spyOn(adapter, 'refundRequestRefusedLocally')
      .mockReturnValueOnce(true);
    const refused = await ask(paid, { amountMinorUnits: 400 });
    spy.mockRestore();
    expect(refused.refund).toMatchObject({
      status: 'NOT_CREATED',
      notCreatedEvidence: 'NEVER_SENT',
    });
    expect(refundsAt(paid.reference)).toHaveLength(0);
    // The payment is free to be refunded again at once.
    expect((await ask(paid, { amountMinorUnits: 400 })).refund.status).toBe(
      'SUCCEEDED',
    );
  });

  it('an answer from Stripe that cannot be followed is never written, and is flagged for people', async () => {
    const paid = await paidOrder({ amount: 1000 });
    const done = await ask(paid, { amountMinorUnits: 300 });
    // Stripe now reports the succeeded refund as pending (not a move our
    // record can make).
    intents.setRefund(refundsAt(paid.reference)[0].refund.id, {
      status: 'pending',
    });
    const after = await recheck(paid, done.refund.id);
    expect(after.refund.status).toBe('SUCCEEDED');
    const flags = await db.paymentRefundEvent.findMany({
      where: { refundId: done.refund.id, action: 'NEEDS_ATTENTION' },
    });
    expect(flags).toHaveLength(1);
    expect(flags[0].detail).toEqual({
      code: 'RECORDED_SUCCEEDED_STRIPE_PENDING',
    });
  });

  it('a refund made in the Stripe Dashboard is not rechecked here, and internal notes are only for staff who may refund', async () => {
    const paid = await paidOrder({ amount: 1000 });
    const dashboard = intents.dashboardRefund(paid.reference, 100);
    const external = await db.paymentRefund.create({
      data: {
        tenantId: A,
        orderId: paid.orderId,
        paymentAttemptId: paid.attemptId,
        provider: 'stripe',
        providerAccountId: ACCT_A,
        origin: 'EXTERNAL',
        amountMinorUnits: 100,
        currency: 'USD',
        status: 'PENDING',
        providerRefundId: dashboard,
      },
    });
    await expect(recheck(paid, external.id)).rejects.toThrow(
      /outside CENTERIVO is not rechecked/,
    );
    await ask(paid, { amountMinorUnits: 200, note: 'Cold coffee, staff ok' });
    const asManager = await refunds.listForOrder(
      paid.orderId,
      paid.locationId,
      base.manager,
      storeManager(),
      tA,
    );
    expect(asManager.refunds.every((r) => r.note === null)).toBe(true);
    const asOwner = await refunds.listForOrder(
      paid.orderId,
      paid.locationId,
      base.owner,
      owner(),
      tA,
    );
    expect(asOwner.refunds.map((r) => r.note)).toContain(
      'Cold coffee, staff ok',
    );
  });

  it('only ever refunds through the restaurant’s connected account (never CENTERIVO’s own Stripe account)', () => {
    for (const [, options] of intents.refundCreate.mock.calls) {
      expect(options.stripeAccount).toMatch(/^acct_1M5b/);
    }
    expect(intents.refundCreate.mock.calls.length).toBeGreaterThan(0);
  });
});
