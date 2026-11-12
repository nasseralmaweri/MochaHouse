import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@mocha-house/database';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  tenantContextFor,
  type ScratchDatabase,
} from '@mocha-house/testing';
import type { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import type { CheckoutService } from './checkout.service';
import type { GiftCardPurchaseService } from '../../gift-cards/application/gift-card-purchase.service';
import { OrderRefundsService } from './order-refunds.service';
import { withSessionLock } from '../../payment/session-lock';
import {
  NEVER_SENT_AFTER_MS,
  RefundReconciliationService,
} from './refund-reconciliation.service';
import { PaymentEventsService } from '../../restaurant-payments/payment-events/payment-events.service';
import {
  PaymentRecoveryService,
  refundRecoveryEnabled,
} from '../../payment-recovery/application/payment-recovery.service';
import { PaymentEventVerificationError } from '../../restaurant-payments/provider/stripe-payment-intent-provider';
import {
  fakeStripePayments,
  signedRefundEvent,
  stripeError,
} from '../../../test/fake-stripe-intents';

// ESP-04 M5c — refund reconciliation and recovery against a REAL PostgreSQL
// schema (every migration, including M5a's guards) on a scratch database,
// with the real Stripe adapter over an in-memory stand-in (no network, no
// Stripe account), signed refund webhooks through the real payment-events
// service, and the real recovery sweeper. Reconciliation is READ-ONLY
// towards Stripe: it never creates a refund.

jest.setTimeout(300_000);

const migrations = listMigrations(
  join(__dirname, '../../../../../packages/database/prisma/migrations'),
);
const A = '01a0db02-f800-7000-8000-000000005c0a';
const B = '01a0db02-f800-7000-8000-000000005c0b';
const ACCT_A = 'acct_1M5cTenantA';
const ACCT_B = 'acct_1M5cTenantB';
const HOUR = 60 * 60 * 1000;

describe('ESP-04 M5c: refund reconciliation and recovery (scratch database, offline Stripe)', () => {
  let scratch: ScratchDatabase;
  let db: PrismaClient;
  let refunds: OrderRefundsService;
  let reconciliation: RefundReconciliationService;
  let events: PaymentEventsService;
  let recovery: PaymentRecoveryService;
  const { stripe, intents, provider } = fakeStripePayments(new Set([A, B]));
  const tA = tenantContextFor(A);
  const env = { ...process.env };
  const base = { locA: '', locB: '', owner: { id: '', tenantId: A } };
  const owner = () =>
    AuthorizationContext.of({
      'orders.view': [{ scopeType: 'CORPORATE', scopeId: null }],
      'orders.refund': [{ scopeType: 'CORPORATE', scopeId: null }],
    });

  beforeAll(async () => {
    process.env.RESTAURANT_REFUNDS_ENABLED = '1';
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'm5c_reconcile',
    );
    await applyMigrations(scratch.url, migrations);
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: scratch.url }),
    });
    await db.$connect();
    const prisma = db as unknown as PrismaService;
    refunds = new OrderRefundsService(
      prisma,
      new InternalAuditService(),
      provider,
    );
    reconciliation = new RefundReconciliationService(prisma, provider);
    events = new PaymentEventsService(
      prisma,
      {} as CheckoutService,
      reconciliation,
      provider,
    );
    recovery = new PaymentRecoveryService(
      prisma,
      {
        abandonStrandedUnsentAttempts: () => Promise.resolve(0),
      } as unknown as CheckoutService,
      {} as GiftCardPurchaseService,
      provider,
      reconciliation,
    );
    await db.tenant.createMany({
      data: [
        { id: A, slug: 'm5c-a', name: 'Tenant A', status: 'ACTIVE' },
        { id: B, slug: 'm5c-b', name: 'Tenant B', status: 'ACTIVE' },
      ],
    });
    base.locA = (
      await db.location.create({
        data: { tenantId: A, name: 'm5c-a', slug: 'm5c-a' },
      })
    ).id;
    base.locB = (
      await db.location.create({
        data: { tenantId: B, name: 'm5c-b', slug: 'm5c-b' },
      })
    ).id;
    const user = (tenantId: string, email: string) =>
      db.internalUser.create({
        data: {
          tenantId,
          externalProvider: 'internal-dev',
          externalSubject: `internal-dev:${email}`,
          email,
          status: 'ACTIVE',
        },
        select: { id: true, tenantId: true },
      });
    base.owner = await user(A, 'owner@m5c-a.test');
    const ownerB = await user(B, 'owner@m5c-b.test');
    for (const [tenantId, account, by] of [
      [A, ACCT_A, base.owner.id],
      [B, ACCT_B, ownerB.id],
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
    // Refund webhooks and recovery reconcile only with their switch on.
    process.env.RESTAURANT_REFUND_RECOVERY_ENABLED = '1';
  });

  // --- fixtures ---------------------------------------------------------------

  interface Paid {
    orderId: string;
    attemptId: string;
    reference: string;
    tenantId: string;
    locationId: string;
    account: string;
  }

  async function paidOrder(
    o: {
      tenantId?: string;
      amount?: number;
      status?: 'COMPLETED' | 'ACCEPTED';
    } = {},
  ): Promise<Paid> {
    const tenantId = o.tenantId ?? A;
    const amount = o.amount ?? 1000;
    const account = tenantId === A ? ACCT_A : ACCT_B;
    const locationId = tenantId === A ? base.locA : base.locB;
    const intent = await intents.create(
      {
        amount,
        currency: 'usd',
        payment_method_types: ['card'],
        metadata: { centerivo_tenant_id: tenantId },
      },
      { stripeAccount: account, idempotencyKey: `m5c-${randomUUID()}` },
    );
    intents.succeed(intent.id);
    intents.withCharge(intent.id);
    const attempt = await db.paymentAttempt.create({
      data: {
        tenantId,
        idempotencyKey: `m5c-${randomUUID()}`,
        provider: 'stripe',
        locationId,
        amount,
        currency: 'USD',
        status: 'SUCCEEDED',
        paymentState: 'SUCCEEDED',
        providerReference: intent.id,
        providerAccountId: account,
      },
    });
    const order = await db.order.create({
      data: {
        tenantId,
        orderNumber: `M5C-${randomUUID().slice(0, 12)}`,
        accessToken: randomUUID(),
        locationId,
        paymentAttemptId: attempt.id,
        guestName: 'Guest',
        guestPhone: '5550000',
        currency: 'USD',
        subtotal: amount,
        status: o.status ?? 'COMPLETED',
      },
    });
    return {
      orderId: order.id,
      attemptId: attempt.id,
      reference: intent.id,
      tenantId,
      locationId,
      account,
    };
  }

  async function cancelled(amount = 1000) {
    const paid = await paidOrder({ amount, status: 'ACCEPTED' });
    const closureId = randomUUID();
    const obligationId = randomUUID();
    await db.$transaction([
      db.$executeRaw`UPDATE "Order" SET status = 'CANCELLED' WHERE id = ${paid.orderId}`,
      db.$executeRaw`INSERT INTO "OrderClosure" (id, "tenantId", "orderId", kind, "fromStatus", "reasonCode", "actorInternalUserId", "refundDueMinorUnits")
        VALUES (${closureId}, ${A}, ${paid.orderId}, 'CANCELLED', 'ACCEPTED', 'CUSTOMER_REQUEST', ${base.owner.id}, ${amount})`,
      db.$executeRaw`INSERT INTO "OrderRefundObligation" (id, "tenantId", "orderId", "closureId", "paymentAttemptId", "amountMinorUnits", currency, "updatedAt")
        VALUES (${obligationId}, ${A}, ${paid.orderId}, ${closureId}, ${paid.attemptId}, ${amount}, 'USD', now())`,
    ]);
    return { ...paid, obligationId };
  }

  const rowsOf = (paid: Paid) =>
    db.paymentRefund.findMany({
      where: { paymentAttemptId: paid.attemptId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  const obligation = (id: string) =>
    db.orderRefundObligation.findUniqueOrThrow({ where: { id } });
  const evtId = () => `evt_M5c${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const deliver = (
    paid: Paid,
    refundId: string,
    type:
      'refund.created' | 'refund.updated' | 'refund.failed' = 'refund.created',
    over: {
      account?: string | null;
      id?: string;
      metadata?: Record<string, string>;
    } = {},
  ) =>
    events.handle(
      provider.verifyPaymentEvent(
        signedRefundEvent(stripe, {
          id: over.id ?? evtId(),
          type,
          account: over.account === undefined ? paid.account : over.account,
          refund: {
            id: refundId,
            paymentIntent: paid.reference,
            metadata: over.metadata,
          },
        }),
      ),
    );
  const staffRefund = async (paid: Paid, amount: number) =>
    refunds.request(
      paid.orderId,
      {
        locationId: paid.locationId,
        requestId: randomUUID(),
        amountMinorUnits: amount,
        currency: 'USD',
        reasonCode: 'CUSTOMER_REQUEST',
        expectedReservedMinorUnits: (await rowsOf(paid))
          .filter((r) =>
            ['REQUESTED', 'PENDING', 'UNKNOWN', 'SUCCEEDED'].includes(r.status),
          )
          .reduce((s, r) => s + r.amountMinorUnits, 0),
      },
      base.owner,
      owner(),
      tA,
    );
  // The disposable-database superuser bypass (T-2), used ONLY to age a
  // refund past a time window.
  const age = (
    refundId: string,
    column: 'firstSentAt' | 'createdAt',
    hours: number,
  ) =>
    db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRawUnsafe(
        `UPDATE "PaymentRefund" SET "${column}" = "${column}" - ${Number(hours)} * interval '1 hour' WHERE id = $1`,
        refundId,
      ),
    ]);
  const createsBefore = () => intents.refundCreate.mock.calls.length;

  // --- webhooks -----------------------------------------------------------------

  it('a Dashboard refund arrives by webhook: recorded once, EXTERNAL, as Stripe reports it (never from the event body)', async () => {
    const paid = await paidOrder({ amount: 1000 });
    const before = createsBefore();
    const stripeRefund = intents.dashboardRefund(paid.reference, 400);
    expect(await deliver(paid, stripeRefund)).toBe(true);
    expect(await rowsOf(paid)).toEqual([
      expect.objectContaining({
        origin: 'EXTERNAL',
        status: 'SUCCEEDED',
        amountMinorUnits: 400, // the read-back, not the body's 999999
        currency: 'USD',
        providerRefundId: stripeRefund,
        providerAccountId: ACCT_A,
        orderId: paid.orderId,
        tenantId: A,
      }),
    ]);
    const stored = await db.restaurantPaymentProviderEvent.findFirstOrThrow({
      where: { type: 'refund.created', externalObjectId: paid.reference },
    });
    expect(stored).toMatchObject({
      status: 'PROCESSED',
      outcome: 'REFUNDS_RECONCILED',
    });
    // It now counts: the staff refund may only take the rest.
    await expect(staffRefund(paid, 601)).rejects.toThrow(/600 available/);
    expect((await staffRefund(paid, 600)).refund.status).toBe('SUCCEEDED');
    expect(createsBefore() - before).toBe(1); // only the staff refund
  });

  it('refuses an unsigned or wrongly signed event; a duplicate delivery changes nothing', async () => {
    const paid = await paidOrder();
    const stripeRefund = intents.dashboardRefund(paid.reference, 100);
    const signed = signedRefundEvent(
      stripe,
      {
        id: evtId(),
        type: 'refund.created',
        account: ACCT_A,
        refund: { id: stripeRefund, paymentIntent: paid.reference },
      },
      'not-the-payments-signing-secret',
    );
    expect(() => provider.verifyPaymentEvent(signed)).toThrow(
      PaymentEventVerificationError,
    );
    const id = evtId();
    expect(await deliver(paid, stripeRefund, 'refund.created', { id })).toBe(
      true,
    );
    expect(await deliver(paid, stripeRefund, 'refund.created', { id })).toBe(
      true,
    );
    // Another event for the same refund (out of order, redelivered).
    expect(await deliver(paid, stripeRefund, 'refund.updated')).toBe(true);
    expect(await rowsOf(paid)).toHaveLength(1);
  });

  it('out of order: a refund.failed delivered first, then refund.created, end in Stripe’s current state', async () => {
    const paid = await paidOrder();
    const stripeRefund = intents.dashboardRefund(
      paid.reference,
      300,
      'pending',
    );
    expect(await deliver(paid, stripeRefund, 'refund.updated')).toBe(true);
    expect((await rowsOf(paid))[0].status).toBe('PENDING');
    intents.setRefund(stripeRefund, { status: 'succeeded' });
    // A stale "created" arriving late changes nothing wrongly.
    expect(await deliver(paid, stripeRefund, 'refund.created')).toBe(true);
    expect((await rowsOf(paid))[0].status).toBe('SUCCEEDED');
    // Its money comes back later.
    intents.setRefund(stripeRefund, {
      status: 'failed',
      failure_reason: 'expired_or_canceled_card',
    });
    expect(await deliver(paid, stripeRefund, 'refund.failed')).toBe(true);
    expect((await rowsOf(paid))[0]).toMatchObject({
      status: 'FAILED_AFTER_SUCCESS',
      providerFailureReason: 'expired_or_canceled_card',
    });
  });

  it('wrong or another business’s account: nothing recorded (unknown account ignored; no matching payment kept for review)', async () => {
    const paid = await paidOrder();
    const stripeRefund = intents.dashboardRefund(paid.reference, 100);
    expect(
      await deliver(paid, stripeRefund, 'refund.created', {
        account: 'acct_1M5cNobodys',
      }),
    ).toBe(true);
    // Tenant B's real account, naming tenant A's payment.
    expect(
      await deliver(paid, stripeRefund, 'refund.created', { account: ACCT_B }),
    ).toBe(true);
    expect(await rowsOf(paid)).toHaveLength(0);
    const kept = await db.restaurantPaymentProviderEvent.findMany({
      where: { type: 'refund.created', externalObjectId: paid.reference },
      select: { status: true, outcome: true },
      orderBy: { receivedAt: 'asc' },
    });
    expect(kept.map((k) => k.status).sort()).toEqual(['IGNORED', 'UNMATCHED']);
  });

  it('a refund whose answer was lost is found by its CENTERIVO id; a Dashboard refund made meanwhile is recorded too', async () => {
    const paid = await paidOrder({ amount: 1000 });
    intents.loseNextRefundResponse = true;
    const lost = await staffRefund(paid, 300);
    expect(lost.refund.status).toBe('UNKNOWN');
    const dashboard = intents.dashboardRefund(paid.reference, 200);
    const before = createsBefore();
    expect(await deliver(paid, dashboard)).toBe(true);
    const rows = await rowsOf(paid);
    const found = rows.find((r) => r.id === lost.refund.id);
    expect(found?.status).toBe('SUCCEEDED');
    expect(found?.providerRefundId).toMatch(/^re_/);
    expect(rows.find((r) => r.origin === 'EXTERNAL')).toMatchObject({
      status: 'SUCCEEDED',
      amountMinorUnits: 200,
    });
    // Read-only: nothing was asked of Stripe.
    expect(createsBefore()).toBe(before);
  });

  it('a Stripe refund naming a CENTERIVO refund this payment does not have is never recorded', async () => {
    const paid = await paidOrder();
    const stripeRefund = intents.dashboardRefund(paid.reference, 100);
    intents.setRefund(stripeRefund, {
      metadata: { centerivo_refund_id: 'not-one-of-ours' },
    });
    expect(await deliver(paid, stripeRefund)).toBe(true);
    expect(await rowsOf(paid)).toHaveLength(0);
    // Left for people durably, not only in a log line.
    expect(
      await db.paymentReconciliationCase.findFirst({
        where: { tenantId: A, paymentAttemptId: paid.attemptId },
      }),
    ).toMatchObject({
      status: 'OPEN',
      reasonCode: 'REFUND_UNKNOWN_CENTERIVO_ID',
    });
  });

  it('with its switch off, a refund webhook is acknowledged and nothing is stored or read', async () => {
    delete process.env.RESTAURANT_REFUND_RECOVERY_ENABLED;
    const paid = await paidOrder();
    const stripeRefund = intents.dashboardRefund(paid.reference, 100);
    const lists = intents.refundList.mock.calls.length;
    const id = evtId();
    expect(await deliver(paid, stripeRefund, 'refund.created', { id })).toBe(
      true,
    );
    expect(
      await db.restaurantPaymentProviderEvent.findFirst({
        where: { externalEventId: id },
      }),
    ).toBeNull();
    expect(intents.refundList.mock.calls.length).toBe(lists);
    expect(await rowsOf(paid)).toHaveLength(0);
  });

  it('a business not on the test-mode allowlist: the refund event is ignored, nothing read or recorded', async () => {
    const paid = await paidOrder();
    const stripeRefund = intents.dashboardRefund(paid.reference, 100);
    const lists = intents.refundList.mock.calls.length;
    const allows = jest.spyOn(provider, 'allowsTenant').mockReturnValue(false);
    try {
      const id = evtId();
      expect(await deliver(paid, stripeRefund, 'refund.created', { id })).toBe(
        true,
      );
      expect(
        await db.restaurantPaymentProviderEvent.findFirstOrThrow({
          where: { externalEventId: id },
        }),
      ).toMatchObject({ status: 'IGNORED', outcome: 'NOT_ALLOWLISTED' });
    } finally {
      allows.mockRestore();
    }
    expect(intents.refundList.mock.calls.length).toBe(lists);
    expect(await rowsOf(paid)).toHaveLength(0);
  });

  it('a refund being sent or rechecked is never changed underneath it; the event is not acknowledged and is applied on redelivery', async () => {
    const paid = await paidOrder({ amount: 1000 });
    intents.loseNextRefundResponse = true;
    const lost = await staffRefund(paid, 300);
    expect(lost.refund.status).toBe('UNKNOWN');
    const id = evtId();
    const held = await withSessionLock(
      `esp04-refund:${A}:${lost.refund.id}`,
      async () => {
        const stamped = await db.paymentAttempt.findUniqueOrThrow({
          where: { id: paid.attemptId },
          select: { refundsReconciledAt: true },
        });
        expect(await deliver(paid, 're_unused', 'refund.updated', { id })).toBe(
          false,
        );
        expect(
          (await rowsOf(paid)).find((r) => r.id === lost.refund.id)?.status,
        ).toBe('UNKNOWN');
        // Not marked reconciled: read again, not left for its schedule.
        expect(
          await db.paymentAttempt.findUniqueOrThrow({
            where: { id: paid.attemptId },
            select: { refundsReconciledAt: true },
          }),
        ).toEqual(stamped);
        return true;
      },
    );
    expect(held).toBe(true);
    expect(await deliver(paid, 're_unused', 'refund.updated', { id })).toBe(
      true,
    );
    expect(
      (await rowsOf(paid)).find((r) => r.id === lost.refund.id)?.status,
    ).toBe('SUCCEEDED');
  });

  it('a refund without our id, the same amount as an unresolved request of ours, is never recorded as made outside CENTERIVO', async () => {
    const paid = await paidOrder({ amount: 1000 });
    intents.loseNextRefundResponse = true;
    const lost = await staffRefund(paid, 300);
    expect(lost.refund.status).toBe('UNKNOWN');
    // Its metadata was cleared at Stripe.
    const listedRefund = [...intents.refunds.values()].find(
      (r) => r.refund.payment_intent === paid.reference,
    )!.refund.id;
    intents.setRefund(listedRefund, { metadata: {} });
    expect(await deliver(paid, listedRefund)).toBe(true);
    const rows = await rowsOf(paid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: lost.refund.id, status: 'UNKNOWN' });
    expect(
      await db.paymentRefundEvent.findFirst({
        where: { refundId: lost.refund.id, action: 'NEEDS_ATTENTION' },
      }),
    ).toMatchObject({
      detail: expect.objectContaining({
        code: 'UNATTRIBUTED_REFUND_SAME_AMOUNT',
      }) as unknown,
    });
  });

  it('a full Dashboard refund of a cancelled order settles its obligation; a partial one leaves the rest owed', async () => {
    const full = await cancelled(800);
    await deliver(full, intents.dashboardRefund(full.reference, 800));
    expect(await obligation(full.obligationId)).toMatchObject({
      status: 'REFUNDED',
      settlementMethod: 'PROCESSOR',
    });
    const partial = await cancelled(800);
    await deliver(partial, intents.dashboardRefund(partial.reference, 300));
    expect((await obligation(partial.obligationId)).status).toBe('PROCESSING');
    const view = await refunds.listForOrder(
      partial.orderId,
      partial.locationId,
      base.owner,
      owner(),
      tA,
    );
    expect(view.obligation).toMatchObject({
      outstandingMinorUnits: 500,
      fullyRefunded: false,
    });
    expect(view.refunds[0]).toMatchObject({
      origin: 'EXTERNAL',
      status: 'SUCCEEDED',
    });
  });

  it('a late failure after settlement is owed again and blocks a replacement until reviewed', async () => {
    const order = await cancelled(600);
    const stripeRefund = intents.dashboardRefund(order.reference, 600);
    await deliver(order, stripeRefund);
    expect((await obligation(order.obligationId)).status).toBe('REFUNDED');
    intents.setRefund(stripeRefund, { status: 'failed' });
    await deliver(order, stripeRefund, 'refund.failed');
    const view = await refunds.listForOrder(
      order.orderId,
      order.locationId,
      base.owner,
      owner(),
      tA,
    );
    expect(view.obligation).toMatchObject({
      recordedStatus: 'REFUNDED',
      outstandingMinorUnits: 600,
      needsAttention: true,
    });
    await expect(staffRefund(order, 600)).rejects.toThrow(/must be reviewed/);
  });

  it('a database failure during reconciliation is not acknowledged; redelivery records it once', async () => {
    const paid = await paidOrder();
    const stripeRefund = intents.dashboardRefund(paid.reference, 250);
    // The database fails while the refund is being written.
    const spy = jest
      .spyOn(db, '$transaction')
      .mockRejectedValueOnce(new Error('database unavailable'));
    const id = evtId();
    expect(await deliver(paid, stripeRefund, 'refund.created', { id })).toBe(
      false,
    );
    spy.mockRestore();
    expect(await rowsOf(paid)).toHaveLength(0);
    // Stripe delivers it again (or the re-drive does): recorded once.
    expect(await deliver(paid, stripeRefund, 'refund.created', { id })).toBe(
      true,
    );
    expect(await deliver(paid, stripeRefund, 'refund.created', { id })).toBe(
      true,
    );
    expect(await rowsOf(paid)).toHaveLength(1);
  });

  it('an unreadable Stripe history changes nothing and is not acknowledged', async () => {
    const paid = await paidOrder();
    const stripeRefund = intents.dashboardRefund(paid.reference, 100);
    intents.refundListError = stripeError('StripeConnectionError');
    expect(await deliver(paid, stripeRefund)).toBe(false);
    expect(await rowsOf(paid)).toHaveLength(0);
    const spy = jest
      .spyOn(provider, 'listRefundsFor')
      .mockResolvedValueOnce({ refunds: [], complete: false });
    expect(await deliver(paid, stripeRefund)).toBe(false);
    spy.mockRestore();
    expect(await deliver(paid, stripeRefund)).toBe(true);
    expect(await rowsOf(paid)).toHaveLength(1);
  });

  // --- automatic recovery -------------------------------------------------------

  it('is off by default: the sweep reads no refunds unless its switch is on', async () => {
    delete process.env.RESTAURANT_REFUND_RECOVERY_ENABLED;
    expect(refundRecoveryEnabled()).toBe(false);
    const paid = await paidOrder();
    intents.dashboardRefund(paid.reference, 100);
    const lists = intents.refundList.mock.calls.length;
    await recovery.sweep();
    expect(intents.refundList.mock.calls.length).toBe(lists);
    expect(await rowsOf(paid)).toHaveLength(0);
  });

  it('a lost webhook is recovered by the sweep (read-only: never creates a refund)', async () => {
    process.env.RESTAURANT_REFUND_RECOVERY_ENABLED = '1';
    const order = await cancelled(500);
    intents.dashboardRefund(order.reference, 500);
    const before = createsBefore();
    await recovery.sweep();
    expect(await rowsOf(order)).toEqual([
      expect.objectContaining({ origin: 'EXTERNAL', status: 'SUCCEEDED' }),
    ]);
    expect((await obligation(order.obligationId)).status).toBe('REFUNDED');
    expect(createsBefore()).toBe(before);
    // Reconciled: not read again on the next sweep (its schedule).
    const lists = intents.refundList.mock.calls.length;
    await recovery.sweep();
    expect(
      intents.refundList.mock.calls
        .slice(lists)
        .filter(([p]) => p.payment_intent === order.reference),
    ).toHaveLength(0);
  });

  it('recovery follows pending refunds and finds late failures of recent successes', async () => {
    process.env.RESTAURANT_REFUND_RECOVERY_ENABLED = '1';
    const paid = await paidOrder({ amount: 1000 });
    intents.nextRefundStatus = 'pending';
    const pending = await staffRefund(paid, 400);
    expect(pending.refund.status).toBe('PENDING');
    await age(pending.refund.id, 'createdAt', 1);
    const stripeId = (await rowsOf(paid))[0].providerRefundId!;
    intents.setRefund(stripeId, { status: 'succeeded' });
    await reconciliation.reconcilePayment(A, paid.attemptId);
    expect((await rowsOf(paid))[0].status).toBe('SUCCEEDED');
    intents.setRefund(stripeId, { status: 'failed' });
    await reconciliation.reconcilePayment(A, paid.attemptId);
    expect((await rowsOf(paid))[0].status).toBe('FAILED_AFTER_SUCCESS');
  });

  it('recovery records "never created" only with evidence; without it the amount stays reserved', async () => {
    const paid = await paidOrder({ amount: 1000 });
    // A request whose sending never happened (the sender stopped first).
    const stale = await db.paymentRefund
      .create({
        data: {
          id: randomUUID(),
          tenantId: A,
          orderId: paid.orderId,
          paymentAttemptId: paid.attemptId,
          provider: 'stripe',
          providerAccountId: ACCT_A,
          origin: 'CENTERIVO',
          amountMinorUnits: 200,
          currency: 'USD',
          reasonCode: 'CUSTOMER_REQUEST',
          requestedByInternalUserId: base.owner.id,
          idempotencyKey: 'x',
          status: 'REQUESTED',
          clientRequestId: randomUUID(),
          requestFingerprint: 'a'.repeat(64),
        },
      })
      .catch(() => null);
    // (The key must be its own: created properly instead.)
    expect(stale).toBeNull();
    const id = randomUUID();
    await db.paymentRefund.create({
      data: {
        id,
        tenantId: A,
        orderId: paid.orderId,
        paymentAttemptId: paid.attemptId,
        provider: 'stripe',
        providerAccountId: ACCT_A,
        origin: 'CENTERIVO',
        amountMinorUnits: 200,
        currency: 'USD',
        reasonCode: 'CUSTOMER_REQUEST',
        requestedByInternalUserId: base.owner.id,
        idempotencyKey: `centerivo-refund:${id}`,
        status: 'REQUESTED',
        clientRequestId: randomUUID(),
        requestFingerprint: 'a'.repeat(64),
      },
    });
    // Just made: a sending may be in progress — untouched.
    await reconciliation.reconcilePayment(A, paid.attemptId);
    expect((await rowsOf(paid))[0].status).toBe('REQUESTED');
    await age(id, 'createdAt', NEVER_SENT_AFTER_MS / HOUR + 1);
    await reconciliation.reconcilePayment(A, paid.attemptId);
    expect((await rowsOf(paid))[0]).toMatchObject({
      status: 'NOT_CREATED',
      notCreatedEvidence: 'NEVER_SENT',
    });

    // A request that WAS sent, whose answer was lost, that Stripe never made:
    // inside 24 hours absence proves nothing.
    const other = await paidOrder({ amount: 1000 });
    intents.refundCreateError = stripeError('StripeAPIError', undefined, 500);
    const unknown = await staffRefund(other, 300);
    expect(unknown.refund.status).toBe('UNKNOWN');
    await age(unknown.refund.id, 'createdAt', 1);
    const before = createsBefore();
    await reconciliation.reconcilePayment(A, other.attemptId);
    expect((await rowsOf(other))[0].status).toBe('UNKNOWN');
    // Past 24 hours, with a complete history showing nothing of it: proven.
    await age(unknown.refund.id, 'firstSentAt', 25);
    await reconciliation.reconcilePayment(A, other.attemptId);
    expect((await rowsOf(other))[0]).toMatchObject({
      status: 'NOT_CREATED',
      notCreatedEvidence: 'STRIPE_HISTORY_VERIFIED',
    });
    // Never replayed by recovery.
    expect(createsBefore()).toBe(before);
  });

  it('concurrent reconciliations of one payment record it once', async () => {
    const paid = await paidOrder();
    intents.dashboardRefund(paid.reference, 150);
    const results = await Promise.all([
      reconciliation.reconcilePayment(A, paid.attemptId),
      reconciliation.reconcilePayment(A, paid.attemptId),
      reconciliation.reconcilePayment(A, paid.attemptId),
    ]);
    expect(results.some((r) => r.kind === 'reconciled')).toBe(true);
    expect(await rowsOf(paid)).toHaveLength(1);
    // Repeated later: still one.
    await reconciliation.reconcilePayment(A, paid.attemptId);
    expect(await rowsOf(paid)).toHaveLength(1);
  });

  it('a re-driven unfinished refund event is processed again, idempotently', async () => {
    const paid = await paidOrder();
    const stripeRefund = intents.dashboardRefund(paid.reference, 120);
    intents.refundListError = stripeError('StripeConnectionError');
    const id = evtId();
    expect(await deliver(paid, stripeRefund, 'refund.created', { id })).toBe(
      false,
    );
    await db.restaurantPaymentProviderEvent.updateMany({
      where: { externalEventId: id },
      data: {
        receivedAt: new Date(Date.now() - HOUR),
        lastAttemptAt: new Date(Date.now() - HOUR),
      },
    });
    await events.redrive();
    expect(await rowsOf(paid)).toHaveLength(1);
    expect(
      (
        await db.restaurantPaymentProviderEvent.findFirstOrThrow({
          where: { externalEventId: id },
        })
      ).status,
    ).toBe('PROCESSED');
  });

  it('recovery never calls Stripe to create, replay or cancel a refund', () => {
    // Every refunds.create call in this suite came from a staff refund
    // request (each with its own operation key), never from reconciliation.
    for (const [, options] of intents.refundCreate.mock.calls) {
      expect(options.idempotencyKey).toMatch(/^centerivo-refund:/);
    }
    expect(intents.stripeCancel).not.toHaveBeenCalled();
  });
});
