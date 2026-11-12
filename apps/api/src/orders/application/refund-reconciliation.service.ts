import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PaymentProvider } from '@mocha-house/integrations';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { PAYMENT_PROVIDER } from '../../payment/payment-provider.token';
import { paymentAccountForAttempt } from '../../payment/payment-intent';
import { withSessionLock } from '../../payment/session-lock';
import {
  notCreatedEvidenceFor,
  transitionFor,
  type PaymentRefundStatus,
} from '../../payment/payment-refunds';
import {
  StripePaymentIntentProvider,
  type RefundObservation,
} from '../../restaurant-payments/provider/stripe-payment-intent-provider';
import { openReconciliationCase } from '../../payment/payment-charge';
import { syncRefundObligation } from './refund-obligation-sync';

// ESP-04 M5c — keeps a payment's refund records true to Stripe, READ-ONLY
// towards Stripe: it lists and reads refunds, never creates, replays or
// cancels one, and never uses an idempotency key. Used by refund webhooks
// (a nudge: nothing in an event is trusted) and by the automatic refund
// recovery (off unless RESTAURANT_REFUND_RECOVERY_ENABLED=1).
//
// For one payment, under its own session lock, with no database
// transaction open across the network:
//   1. its refunds as Stripe holds them, read IN FULL on the payment's own
//      connected account (an unreadable or incomplete history changes
//      nothing);
//   2. each Stripe refund is matched to our record: by its Stripe id, or —
//      a CENTERIVO request whose answer was lost — by our refund id in its
//      metadata AND its amount and currency;
//   3. a known refund moves only as the read-back says (pending ->
//      succeeded / failed, succeeded -> FAILED_AFTER_SUCCESS); anything it
//      cannot follow is flagged for people, never written;
//   4. a refund made outside CENTERIVO (no CENTERIVO id) is recorded once,
//      EXTERNAL, as Stripe reports it — only for an order's own payment;
//      the database guards (capacity, identity, uniqueness) still apply;
//   5. a CENTERIVO request Stripe never made is recorded NOT_CREATED only
//      with M5a's evidence (never sent, or a complete history past the
//      idempotency window); otherwise it stays UNKNOWN, its amount
//      reserved;
//   6. the order's refund obligation follows (the shared sync), and the
//      payment's reconciliation time is recorded (the recovery schedule).
// A CENTERIVO refund is changed only while holding that refund's own lock
// (the one staff refunds send under), so this never races a sending.

// OFF unless the deployment sets it: both refund webhooks and the automatic
// refund recovery reconcile only then.
export function refundReconciliationEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.RESTAURANT_REFUND_RECOVERY_ENABLED === '1';
}

export const REFUND_RECONCILE_TIMEOUT_MS = 20_000;
// A CENTERIVO request never marked sent, this old, was abandoned before
// Stripe was asked (sending needs its lock and marks it first).
export const NEVER_SENT_AFTER_MS = 15 * 60 * 1000;

export type ReconcileResult =
  | { kind: 'reconciled'; changes: number; flagged: number }
  // Another reconciliation of this payment is running, or one of its
  // refunds is being sent or rechecked: what could be done was, but the
  // payment is not marked reconciled (it is read again).
  | { kind: 'busy' }
  // Stripe could not be read in full (or the account is no longer the
  // payment's): nothing changed.
  | { kind: 'unreadable'; reason: string }
  // Not a refundable Stripe payment of an order, or Stripe not configured.
  | { kind: 'not_applicable'; reason: string };

type RefundRecord = Prisma.PaymentRefundGetPayload<Record<string, never>>;

@Injectable()
export class RefundReconciliationService {
  private readonly logger = new Logger(RefundReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async reconcilePayment(
    tenantId: string,
    paymentAttemptId: string,
    now: Date = new Date(),
  ): Promise<ReconcileResult> {
    if (!(this.provider instanceof StripePaymentIntentProvider)) {
      return { kind: 'not_applicable', reason: 'PAYMENTS_NOT_CONFIGURED' };
    }
    const provider = this.provider;
    const result = await withSessionLock(
      `esp04-refund-reconcile:${tenantId}:${paymentAttemptId}`,
      () => this.reconcileLocked(provider, tenantId, paymentAttemptId, now),
    );
    return result ?? { kind: 'busy' };
  }

  private async reconcileLocked(
    provider: StripePaymentIntentProvider,
    tenantId: string,
    paymentAttemptId: string,
    now: Date,
  ): Promise<ReconcileResult> {
    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: { id: paymentAttemptId, tenantId, provider: 'stripe' },
      select: {
        id: true,
        tenantId: true,
        providerReference: true,
        providerAccountId: true,
        order: { select: { id: true, tenantId: true } },
      },
    });
    if (
      !attempt ||
      attempt.providerReference === null ||
      attempt.providerAccountId === null
    ) {
      return { kind: 'not_applicable', reason: 'NOT_A_STRIPE_PAYMENT' };
    }
    const account = await paymentAccountForAttempt(this.prisma, attempt);
    if (!account || account.connectedAccountId !== attempt.providerAccountId) {
      await this.stamp(tenantId, attempt.id, now);
      return { kind: 'unreadable', reason: 'ACCOUNT_CHANGED' };
    }
    const listed = await bounded(
      provider.listRefundsFor({
        reference: attempt.providerReference,
        account,
      }),
    ).catch(() => null);
    if (!listed || !listed.complete) {
      await this.stamp(tenantId, attempt.id, now);
      return {
        kind: 'unreadable',
        reason: listed ? 'HISTORY_INCOMPLETE' : 'STRIPE_UNREADABLE',
      };
    }

    let changes = 0;
    let flagged = 0;
    let busy = 0;
    const rows = await this.rowsOf(tenantId, attempt.id);
    const matched = new Set<string>();
    // Oldest first (Stripe lists newest first).
    for (const observed of [...listed.refunds].reverse()) {
      const byId = rows.find(
        (r) => r.providerRefundId === observed.providerRefundId,
      );
      const byRequest =
        byId ??
        (observed.centerivoRefundId
          ? rows.find(
              (r) =>
                r.id === observed.centerivoRefundId &&
                r.origin === 'CENTERIVO' &&
                r.providerRefundId === null,
            )
          : undefined);
      const row = byId ?? byRequest;
      if (row) {
        matched.add(row.id);
        if (
          row.amountMinorUnits !== observed.amountMinorUnits ||
          row.currency !== observed.currency ||
          (row.origin === 'CENTERIVO' && observed.centerivoRefundId !== row.id)
        ) {
          // Not this refund after all (another amount, currency or
          // operation): never recorded as it; people must look.
          flagged += await this.flag(row, 'STRIPE_REFUND_MISMATCH', now);
          continue;
        }
        const outcome = await this.follow(row, observed, now);
        if (outcome === 'changed') changes += 1;
        if (outcome === 'flagged') flagged += 1;
        if (outcome === 'busy') busy += 1;
        continue;
      }
      if (observed.centerivoRefundId !== null) {
        // Carries a CENTERIVO refund id this payment has no record of: never
        // guessed at, never recorded as made outside CENTERIVO.
        flagged += await this.flagPayment(
          attempt.id,
          'REFUND_UNKNOWN_CENTERIVO_ID',
          observed,
        );
        continue;
      }
      if (!attempt.order || attempt.order.tenantId !== tenantId) {
        // Not an order's payment (e.g. a gift-card purchase): no order to
        // link it to, never invented.
        flagged += await this.flagPayment(
          attempt.id,
          'REFUND_ON_NON_ORDER_PAYMENT',
          observed,
        );
        continue;
      }
      // M5a's protection kept: a refund without our id but of the same
      // amount as one of our unresolved requests may be that request (its
      // metadata lost) — never recorded as made outside CENTERIVO while the
      // request is open; people must look.
      const lookalike = rows.find(
        (r) =>
          r.origin === 'CENTERIVO' &&
          r.providerRefundId === null &&
          !matched.has(r.id) &&
          (r.status === 'REQUESTED' || r.status === 'UNKNOWN') &&
          r.amountMinorUnits === observed.amountMinorUnits &&
          r.currency === observed.currency,
      );
      if (lookalike) {
        matched.add(lookalike.id);
        flagged += await this.flag(
          lookalike,
          'UNATTRIBUTED_REFUND_SAME_AMOUNT',
          now,
        );
        continue;
      }
      const recorded = await this.recordExternal(
        tenantId,
        attempt.order.id,
        attempt.id,
        attempt.providerAccountId,
        observed,
      );
      if (recorded === 'recorded') changes += 1;
      if (recorded === 'refused') {
        flagged += await this.flagPayment(
          attempt.id,
          'EXTERNAL_REFUND_REFUSED',
          observed,
        );
      }
      if (recorded === 'skipped') {
        flagged += await this.flagPayment(
          attempt.id,
          'EXTERNAL_REFUND_STATE_UNKNOWN',
          observed,
        );
      }
    }

    // CENTERIVO requests Stripe did not list: never sent, or proven never
    // created; otherwise left UNKNOWN, their amounts reserved.
    const fresh = await this.rowsOf(tenantId, attempt.id);
    const recordedIds = new Set(
      fresh.flatMap((r) => (r.providerRefundId ? [r.providerRefundId] : [])),
    );
    for (const row of fresh) {
      if (
        matched.has(row.id) ||
        row.origin !== 'CENTERIVO' ||
        row.providerRefundId !== null ||
        (row.status !== 'REQUESTED' && row.status !== 'UNKNOWN')
      ) {
        continue;
      }
      const evidence =
        row.firstSentAt === null
          ? now.getTime() - row.createdAt.getTime() >= NEVER_SENT_AFTER_MS
            ? ('NEVER_SENT' as const)
            : null
          : notCreatedEvidenceFor({
              refundId: row.id,
              amountMinorUnits: row.amountMinorUnits,
              firstSentAt: row.firstSentAt,
              now,
              listed,
              recordedProviderRefundIds: recordedIds,
            });
      if (!evidence) continue;
      const marked = await this.markNotCreated(row, evidence);
      if (marked === 'changed') changes += 1;
      if (marked === 'busy') busy += 1;
    }

    // Something was skipped because its refund was being sent or rechecked:
    // not marked reconciled, so the event is delivered again / the payment
    // is read again soon.
    if (busy > 0) return { kind: 'busy' };
    await this.stamp(tenantId, attempt.id, now);
    return { kind: 'reconciled', changes, flagged };
  }

  // One of our refunds, as Stripe now reports it. A CENTERIVO refund is
  // changed only under its own lock (never while it is being sent).
  private async follow(
    row: RefundRecord,
    observed: RefundObservation,
    now: Date,
  ): Promise<'changed' | 'unchanged' | 'flagged' | 'busy'> {
    const apply = async (): Promise<'changed' | 'unchanged' | 'flagged'> => {
      const current = await this.prisma.paymentRefund.findFirstOrThrow({
        where: { id: row.id, tenantId: row.tenantId },
      });
      const from = current.status as PaymentRefundStatus;
      const transition = transitionFor(from, observed.state);
      if (transition.kind === 'anomaly') {
        return (await this.flag(
          current,
          `RECORDED_${from}_STRIPE_${observed.state.toUpperCase()}`,
          now,
        ))
          ? 'flagged'
          : 'unchanged';
      }
      const data: Prisma.PaymentRefundUpdateManyMutationInput = {};
      if (current.providerRefundId === null) {
        data.providerRefundId = observed.providerRefundId;
      }
      if (transition.kind === 'move') {
        data.status = transition.to;
        if (
          (transition.to === 'FAILED' ||
            transition.to === 'CANCELED' ||
            transition.to === 'FAILED_AFTER_SUCCESS') &&
          observed.failureReason
        ) {
          data.providerFailureReason = observed.failureReason;
        }
      }
      if (Object.keys(data).length === 0) return 'unchanged';
      let changed = false;
      await this.prisma.$transaction(async (tx) => {
        const moved = await tx.paymentRefund.updateMany({
          where: {
            id: current.id,
            tenantId: current.tenantId,
            status: from,
            // Never one Stripe refund's state on a record bound to another.
            OR: [
              { providerRefundId: null },
              { providerRefundId: observed.providerRefundId },
            ],
          },
          data,
        });
        if (moved.count !== 1) return;
        changed = true;
        await syncRefundObligation(
          tx,
          current.tenantId,
          current.paymentAttemptId,
        );
      });
      return changed ? 'changed' : 'unchanged';
    };
    if (row.origin !== 'CENTERIVO') return apply();
    const locked = await withSessionLock(
      `esp04-refund:${row.tenantId}:${row.id}`,
      apply,
    );
    return locked ?? 'busy';
  }

  // A refund made outside CENTERIVO (the restaurant's Stripe Dashboard),
  // recorded once, exactly as Stripe's read-back reports it.
  private async recordExternal(
    tenantId: string,
    orderId: string,
    paymentAttemptId: string,
    providerAccountId: string,
    observed: RefundObservation,
  ): Promise<'recorded' | 'already' | 'refused' | 'skipped'> {
    const status = externalStatusOf(observed.state);
    if (!status) return 'skipped';
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.paymentRefund.create({
          data: {
            tenantId,
            orderId,
            paymentAttemptId,
            provider: 'stripe',
            providerAccountId,
            origin: 'EXTERNAL',
            amountMinorUnits: observed.amountMinorUnits,
            currency: observed.currency,
            status,
            providerRefundId: observed.providerRefundId,
            providerFailureReason:
              (status === 'FAILED' || status === 'CANCELED') &&
              observed.failureReason
                ? observed.failureReason
                : null,
          },
        });
        await syncRefundObligation(tx, tenantId, paymentAttemptId);
      });
      return 'recorded';
    } catch (error) {
      // Recorded already (a concurrent reconciliation, or another payment
      // claims the same Stripe refund id — refused by the unique key).
      if (isUniqueViolation(error)) {
        const mine = await this.prisma.paymentRefund.findFirst({
          where: {
            tenantId,
            paymentAttemptId,
            providerRefundId: observed.providerRefundId,
          },
          select: { id: true },
        });
        // Not this payment's: another record claims this Stripe refund.
        return mine ? 'already' : 'refused';
      }
      // The database itself failing (not a guard's refusal): propagated, so
      // the event is delivered again and the payment is not marked
      // reconciled — nothing is lost.
      if (!isGuardRefusal(error)) throw error;
      // A database guard refused it (e.g. the payment is not a confirmed
      // Stripe payment of this order): never forced in; people must look.
      this.logger.warn(
        `payment ${paymentAttemptId}: a refund made outside CENTERIVO could not be recorded (${
          error instanceof Error ? error.name : 'unknown error'
        }); left for people`,
      );
      return 'refused';
    }
  }

  // NOT_CREATED, with its evidence, under the refund's own lock and only if
  // it is still exactly as it was read.
  private async markNotCreated(
    row: RefundRecord,
    evidence: 'NEVER_SENT' | 'STRIPE_HISTORY_VERIFIED',
  ): Promise<'changed' | 'unchanged' | 'busy'> {
    const done = await withSessionLock(
      `esp04-refund:${row.tenantId}:${row.id}`,
      async () => {
        let changed = false;
        await this.prisma.$transaction(async (tx) => {
          const moved = await tx.paymentRefund.updateMany({
            where: {
              id: row.id,
              tenantId: row.tenantId,
              status: row.status,
              providerRefundId: null,
              // Never sent means STILL never sent.
              ...(evidence === 'NEVER_SENT' ? { firstSentAt: null } : {}),
            },
            data: { status: 'NOT_CREATED', notCreatedEvidence: evidence },
          });
          if (moved.count !== 1) return;
          changed = true;
          await syncRefundObligation(tx, row.tenantId, row.paymentAttemptId);
        });
        return changed;
      },
    );
    if (done === null) return 'busy';
    return done ? 'changed' : 'unchanged';
  }

  // Something people must look at that has no refund record of ours to
  // hang it on: a durable reconciliation case on the payment (one per
  // payment), never only a log line.
  private async flagPayment(
    paymentAttemptId: string,
    code: string,
    observed: RefundObservation,
  ): Promise<number> {
    this.logger.warn(
      `payment ${paymentAttemptId}: Stripe refund ${observed.providerRefundId} needs attention (${code})`,
    );
    await openReconciliationCase(this.prisma, paymentAttemptId, code, {
      source: 'refund-reconciliation',
      providerRefundId: observed.providerRefundId,
    });
    return 1;
  }

  // Something people must look at, in the refund's own history (at most
  // once a day per refund and reason).
  private async flag(
    row: RefundRecord,
    code: string,
    now: Date,
  ): Promise<number> {
    const recent = await this.prisma.paymentRefundEvent.findFirst({
      where: {
        tenantId: row.tenantId,
        refundId: row.id,
        action: 'NEEDS_ATTENTION',
        createdAt: { gt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        detail: { path: ['code'], equals: code.slice(0, 64) },
      },
      select: { id: true },
    });
    if (recent) return 1;
    this.logger.warn(`refund ${row.id}: needs attention (${code})`);
    // A failure here propagates: the event is delivered again rather than
    // the flag being lost.
    await this.prisma.paymentRefundEvent.create({
      data: {
        tenantId: row.tenantId,
        refundId: row.id,
        action: 'NEEDS_ATTENTION',
        actorKind: 'SYSTEM',
        detail: { code: code.slice(0, 64), source: 'reconciliation' },
      },
    });
    return 1;
  }

  private rowsOf(tenantId: string, paymentAttemptId: string) {
    return this.prisma.paymentRefund.findMany({
      where: { tenantId, paymentAttemptId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  private async stamp(tenantId: string, id: string, now: Date): Promise<void> {
    await this.prisma.paymentAttempt
      .updateMany({
        where: { id, tenantId },
        data: { refundsReconciledAt: now },
      })
      .catch(() => undefined);
  }
}

// How a refund made outside CENTERIVO is first recorded; null when Stripe's
// state is not one we can name (nothing recorded).
function externalStatusOf(
  state: RefundObservation['state'],
): 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | null {
  switch (state) {
    case 'pending':
    case 'requires_action':
      return 'PENDING';
    case 'succeeded':
      return 'SUCCEEDED';
    case 'failed':
      return 'FAILED';
    case 'canceled':
      return 'CANCELED';
    default:
      return null;
  }
}

function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Stripe call timed out')),
        REFUND_RECONCILE_TIMEOUT_MS,
      );
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

// A refusal by one of the refund guards (a raised exception in a trigger or
// a CHECK), as opposed to the database being unreachable.
function isGuardRefusal(error: unknown): boolean {
  const raw =
    typeof error === 'object' && error !== null
      ? (error as { message?: unknown }).message
      : undefined;
  return (
    typeof raw === 'string' &&
    // The isolation-level trigger is a misconfiguration, not a refusal.
    !/READ COMMITTED/i.test(raw) &&
    /payment refund|check constraint|cannot exceed|confirmed Stripe payment/i.test(
      raw,
    )
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
