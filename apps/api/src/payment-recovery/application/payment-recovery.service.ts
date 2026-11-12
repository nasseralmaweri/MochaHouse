import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@mocha-house/database';
import { withSessionLock } from '../../payment/session-lock';
import {
  RefundReconciliationService,
  refundReconciliationEnabled,
} from '../../orders/application/refund-reconciliation.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CheckoutService } from '../../orders/application/checkout.service';
import { UnreadableCheckoutSnapshotError } from '../../orders/application/checkout-snapshot';
import { GiftCardPurchaseService } from '../../gift-cards/application/gift-card-purchase.service';
import {
  openReconciliationCase,
  resolveCaseAsFulfilled,
} from '../../payment/payment-charge';
import type { PaymentProvider } from '@mocha-house/integrations';
import { PAYMENT_PROVIDER } from '../../payment/payment-provider.token';
import { paymentAccountForAttempt } from '../../payment/payment-intent';
import {
  RECOVERABLE_HELD_STATES,
  readBackHeldPayment,
  replayPaymentIntentCreation,
  type ReadBack,
} from '../../payment/payment-intent-recovery';
import {
  PAYMENT_EVENT_TYPES,
  StripePaymentIntentProvider,
  type AbandonmentFacts,
} from '../../restaurant-payments/provider/stripe-payment-intent-provider';

// ESP-03 PR 5 — payment reconciliation and automatic recovery.
//
// A payment the provider definitively confirmed (status SUCCEEDED and
// paymentState SUCCEEDED) whose order — or gift card — was never created is
// completed here, from what was durably saved before the charge: the saved
// checkout (CheckoutSnapshot) or the gift-card purchase row. Rules:
//
//   * NEVER charges. Only the PR 4 fulfilment paths are used
//     (CheckoutService.recoverFulfilment, GiftCardPurchaseService.
//     recoverIssuance); both lock the payment row, require a confirmed
//     payment and return a record that already exists, so a recovery racing
//     a customer retry, another recovery or another server still produces
//     exactly one order / card.
//   * Never touches an uncertain payment (pending, held, unknown, never
//     sent, legacy): it is reported as not recoverable and nothing is
//     written. No outcome is ever invented.
//   * Price validation is the order transaction's own: a cart, price or
//     discount that changed since the charge fails the recovery and the case
//     stays open for people (no automatic retry of such a failure).
//   * One recovery per payment at a time, across processes: a session-level
//     PostgreSQL advisory lock, held on a dedicated connection for the whole
//     attempt and released when it ends (or when the connection drops, if
//     the process stops). No database transaction is held open across the
//     work, so no transaction timeout can detach the work from its lock. A
//     second caller is told it is busy and writes nothing.
//   * Every attempt is history on the payment's reconciliation case
//     (append-only SYSTEM events: RECOVERY_STARTED, then RECOVERY_SUCCEEDED or
//     RECOVERY_FAILED, with fixed codes and record ids only). A payment that
//     has no case yet gets one first.
//   * A case is resolved only when the durable record exists (the fulfilment
//     transaction resolves it; a recovery that finds the record already
//     there resolves it under the payment row lock).
//
// The automatic sweeper runs inside the API process (owner decision R1,
// option A) and is OFF unless PAYMENT_AUTO_RECOVERY_ENABLED=1. It works in
// small batches, at most one sweep at a time per process and across
// processes (advisory lock), with exponential backoff between attempts and
// a cap on automatic attempts per payment. Every automatic attempt counts
// toward the cap from the moment it STARTS, so an attempt that is
// interrupted (crash, timeout, lost connection) is capped and backed off
// like a failure, never retried in a tight loop.

export type RecoveryTrigger = 'automatic' | 'platform_support';

// ESP-04 M4a — why a Stripe outcome recovery did not settle the payment.
// Retryable: Stripe could not be read (or proved nothing), or the payment
// moved meanwhile. Not retryable (people must look): the creation can no
// longer be replayed safely, Stripe refuses the key with these parameters
// (or the intent belongs to another payment), no account was recorded, the
// stored account is not the business's, or a different amount was taken.
export type StripeRecheckFailure =
  | 'STRIPE_UNREADABLE'
  | 'STRIPE_STATE_CHANGED'
  | 'STRIPE_CREATE_EXPIRED'
  | 'STRIPE_IDEMPOTENCY_CONFLICT'
  | 'STRIPE_ACCOUNT_MISSING'
  | 'STRIPE_ACCOUNT_MISMATCH'
  | 'STRIPE_AMOUNT_MISMATCH'
  // Paid at Stripe and recorded, but its order is not created yet (fulfilment
  // recovery creates it exactly once).
  | 'STRIPE_FULFILMENT_PENDING';

export type StripeRecheckOutcome =
  | {
      kind: 'settled';
      result: 'PAID' | 'WAITING_FOR_CUSTOMER' | 'PROCESSING' | 'NOT_CHARGED';
    }
  | { kind: 'failed'; failure: StripeRecheckFailure; retryable: boolean }
  // Not a Stripe payment whose outcome only Stripe can settle.
  | { kind: 'not_applicable' }
  | { kind: 'not_found' }
  | { kind: 'busy' };

// Who asked: the sweeper, platform support, or an unmatched Stripe event that
// now names this payment (not counted toward the automatic cap).
export type StripeRecheckTrigger = RecoveryTrigger | 'stripe_event';

// ESP-04 M4b — why an abandoned payment was not cleaned up. Retryable:
// Stripe could not be read, the cancel did not take, or the order of a
// payment found paid is not created yet. Not retryable (people must look):
// an authentication that may still be under way (never cancelled), an
// intent not provably unpaid (another amount, money received, an action or
// a charge pending), or the stored account is not the business's.
export type AbandonFailure =
  | 'STRIPE_UNREADABLE'
  | 'STRIPE_CANCEL_UNCONFIRMED'
  | 'STRIPE_FULFILMENT_PENDING'
  | 'STRIPE_AUTHENTICATION_STALE'
  | 'STRIPE_ABANDON_UNSAFE'
  | 'STRIPE_ACCOUNT_MISMATCH';

// Where an abandoned payment ended: cancelled (holds released), found paid
// (order once) or processing during the race, or the customer came back.
export type AbandonResult =
  'CANCELLED' | 'PAID' | 'PROCESSING' | 'STILL_ACTIVE';

export type AbandonOutcome =
  | { kind: 'settled'; result: AbandonResult }
  | { kind: 'failed'; failure: AbandonFailure; retryable: boolean }
  | { kind: 'not_eligible' }
  | { kind: 'not_applicable' }
  | { kind: 'busy' };

// A provider call bounded in time (an unanswered call rejects).
async function boundedCall<T>(call: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('provider timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type RecoveryFailure =
  | 'FULFILMENT_REJECTED'
  | 'SNAPSHOT_UNREADABLE'
  | 'GIFT_CARD_ISSUE_FAILED'
  | 'TRANSIENT_ERROR';

export type RecoveryOutcome =
  | { kind: 'recovered'; orderId?: string; giftCardPurchaseId?: string }
  | { kind: 'already_fulfilled' }
  | { kind: 'failed'; failure: RecoveryFailure; retryable: boolean }
  | { kind: 'not_found' }
  // The payment is not definitively confirmed: nothing may be recovered.
  | { kind: 'not_confirmed' }
  // Confirmed, but nothing durable to recover from (a payment from before
  // ESP-03 PR 4): people must look at it.
  | { kind: 'nothing_to_recover' }
  // Another recovery of this payment is running right now.
  | { kind: 'busy' };

export interface RecoveryRequest {
  trigger: RecoveryTrigger;
  // Platform support only: the operator who asked (kept in the event detail
  // as an id; the operator's email is never written to business data).
  platformOperatorId?: string;
}

// The first request has this long to finish on its own before a sweep
// touches its payment.
export const RECOVERY_GRACE_MS = 2 * 60 * 1000;
export const SWEEP_INTERVAL_MS = 60 * 1000;
export const SWEEP_BATCH_SIZE = 10;
// Candidates read per page, and pages read per sweep at most (keyset paging,
// so payments waiting out a backoff never hide the ones behind them).
const SWEEP_PAGE_SIZE = 200;
const SWEEP_MAX_PAGES = 10;
export const MAX_AUTOMATIC_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
// A started attempt with no outcome after this long was interrupted (the
// process stopped); it no longer counts as in progress.
export const RECOVERY_STALE_MS = 5 * 60 * 1000;

const SWEEP_LOCK_KEY = 'esp03-payment-auto-recovery-sweep';

// ESP-04 M4a — Stripe outcome recovery. Each Stripe call is bounded; a
// CHARGING payment gets longer before it is touched (its first request may
// still be talking to Stripe, with the SDK's own retries); unmatched events
// are looked at for a week, at most 20 per sweep from a scan of 100, with a
// per-event backoff (1, 2, 4 … 60 minutes) and cap.
export const STRIPE_RECHECK_TIMEOUT_MS = 8_000;
export const STRIPE_CHARGING_GRACE_MS = 10 * 60 * 1000;
export const UNMATCHED_EVENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const UNMATCHED_EVENT_MAX_ATTEMPTS = 8;
const UNMATCHED_EVENT_SCAN = 100;
export const UNMATCHED_EVENT_BATCH = 20;

export function unmatchedBackoffMs(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;
}

// What a payment's state now says, for a recheck that settled it.
function resultOfState(attempt: {
  status: string;
  paymentState: string | null;
}): 'PAID' | 'WAITING_FOR_CUSTOMER' | 'PROCESSING' | 'NOT_CHARGED' {
  if (attempt.status === 'SUCCEEDED') return 'PAID';
  if (attempt.status === 'FAILED' || attempt.status === 'DECLINED') {
    return 'NOT_CHARGED';
  }
  return attempt.paymentState === 'AWAITING_CONFIRMATION'
    ? 'PROCESSING'
    : 'WAITING_FOR_CUSTOMER';
}

// ESP-04 M4b — abandoned Stripe payment cleanup: its own switch, OFF by
// default, and it runs only inside the automatic sweeper (which needs
// PAYMENT_AUTO_RECOVERY_ENABLED=1).
// ESP-04 M5c — the automatic refund recovery: OFF unless
// RESTAURANT_REFUND_RECOVERY_ENABLED=1, and only inside the automatic
// sweeper (PAYMENT_AUTO_RECOVERY_ENABLED=1). Read-only towards Stripe.
export function refundRecoveryEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  // The same switch as refund webhooks (one for all refund reconciliation).
  return refundReconciliationEnabled(env);
}

// How often a payment's refunds are re-read: one waiting for an answer
// (REQUESTED / UNKNOWN / PENDING, past a short grace so a sending in
// progress finishes first), one that succeeded recently (it could still come
// back), and an order's open refund obligation (a refund made in the Stripe
// Dashboard whose event was lost).
export const REFUND_RECOVERY_GRACE_MS = 2 * 60 * 1000;
export const REFUND_RECOVERY_UNRESOLVED_EVERY_MS = 10 * 60 * 1000;
export const REFUND_RECOVERY_SUCCEEDED_EVERY_MS = 24 * 60 * 60 * 1000;
export const REFUND_RECOVERY_SUCCEEDED_FOR_DAYS = 35;
export const REFUND_RECOVERY_OBLIGATION_EVERY_MS = 6 * 60 * 60 * 1000;
export const REFUND_RECOVERY_OBLIGATION_FOR_DAYS = 180;

export function abandonedIntentCancelEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.PAYMENT_ABANDONED_INTENT_CANCEL_ENABLED === '1';
}

export class PaymentRecoveryConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentRecoveryConfigurationError';
  }
}

export const DEFAULT_ABANDON_AFTER_MINUTES = 120;
export const MIN_ABANDON_AFTER_MINUTES = 30;
export const MAX_ABANDON_AFTER_MINUTES = 1440;

// How long a Stripe payment waits for its customer, with no verified
// activity, before it counts as abandoned. Unset: 120. Anything that is not a
// whole number of minutes from 30 to 1440 is refused (the message names the
// variable, never its value).
export function abandonAfterMinutes(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.PAYMENT_ABANDON_AFTER_MINUTES;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_ABANDON_AFTER_MINUTES;
  }
  const value = Number(raw.trim());
  if (
    !/^\d+$/.test(raw.trim()) ||
    value < MIN_ABANDON_AFTER_MINUTES ||
    value > MAX_ABANDON_AFTER_MINUTES
  ) {
    throw new PaymentRecoveryConfigurationError(
      `PAYMENT_ABANDON_AFTER_MINUTES must be a whole number of minutes from ${MIN_ABANDON_AFTER_MINUTES} to ${MAX_ABANDON_AFTER_MINUTES}.`,
    );
  }
  return value;
}

export function automaticRecoveryEnabled(): boolean {
  return process.env.PAYMENT_AUTO_RECOVERY_ENABLED === '1';
}

// Delay before automatic attempt n+1 after n automatic attempts.
export function backoffAfter(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
}

// The recovery history of one case, derived from its append-only events.
export interface RecoveryHistory {
  // Automatic attempts STARTED (whatever their outcome, interrupted ones
  // included).
  automaticAttempts: number;
  // The latest attempt of any trigger (its start, or its failure).
  lastAttemptAt: Date | null;
  lastFailure: RecoveryFailure | StripeRecheckFailure | AbandonFailure | null;
  lastFailureRetryable: boolean;
  lastFailureAt: Date | null;
  // A RECOVERY_STARTED newer than every outcome and not stale.
  inProgressSince: Date | null;
}

type EventRow = { action: string; detail: unknown; createdAt: Date };

// ESP-04 M4a — `prefix` selects the history: RECOVERY (fulfilment) or
// STRIPE_RECHECK (Stripe outcome recovery), counted separately (decision 8).
export function recoveryHistoryOf(
  events: readonly EventRow[],
  now: Date = new Date(),
  prefix: 'RECOVERY' | 'STRIPE_RECHECK' | 'STRIPE_ABANDON' = 'RECOVERY',
): RecoveryHistory {
  const sorted = [...events].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  let automaticAttempts = 0;
  let lastAttemptAt: Date | null = null;
  let lastFailure:
    RecoveryFailure | StripeRecheckFailure | AbandonFailure | null = null;
  let lastFailureRetryable = false;
  let lastFailureAt: Date | null = null;
  let openStart: Date | null = null;
  for (const event of sorted) {
    const detail = (event.detail ?? {}) as Record<string, unknown>;
    if (event.action === `${prefix}_STARTED`) {
      openStart = event.createdAt;
      lastAttemptAt = event.createdAt;
      if (detail.trigger === 'automatic') automaticAttempts += 1;
    } else if (event.action === `${prefix}_FAILED`) {
      openStart = null;
      lastAttemptAt = event.createdAt;
      lastFailure =
        typeof detail.failure === 'string'
          ? (detail.failure as
              RecoveryFailure | StripeRecheckFailure | AbandonFailure)
          : 'TRANSIENT_ERROR';
      lastFailureRetryable = detail.retryable === true;
      lastFailureAt = event.createdAt;
    } else if (
      event.action === `${prefix}_SUCCEEDED` ||
      event.action === 'RESOLVED'
    ) {
      openStart = null;
      // An abandonment that settled (e.g. the customer came back) is not a
      // failed attempt: a later abandonment of the same payment starts a
      // fresh count, exactly as the candidate query counts it.
      if (prefix === 'STRIPE_ABANDON' && event.action !== 'RESOLVED') {
        automaticAttempts = 0;
      }
    }
  }
  const inProgressSince =
    openStart && now.getTime() - openStart.getTime() < RECOVERY_STALE_MS
      ? openStart
      : null;
  return {
    automaticAttempts,
    lastAttemptAt,
    lastFailure,
    lastFailureRetryable,
    lastFailureAt,
    inProgressSince,
  };
}

// When the sweeper will next try this payment, or null if it will not
// (switched off, a failure people must look at, or attempts exhausted).
export function nextAutomaticAttemptAt(
  history: RecoveryHistory,
  updatedAt: Date,
  enabled: boolean = automaticRecoveryEnabled(),
): Date | null {
  if (!enabled) return null;
  if (history.lastFailure !== null && !history.lastFailureRetryable) {
    return null;
  }
  if (history.automaticAttempts >= MAX_AUTOMATIC_ATTEMPTS) return null;
  if (history.lastAttemptAt === null) {
    return new Date(updatedAt.getTime() + RECOVERY_GRACE_MS);
  }
  return new Date(
    history.lastAttemptAt.getTime() + backoffAfter(history.automaticAttempts),
  );
}

@Injectable()
export class PaymentRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentRecoveryService.name);
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly checkout: CheckoutService,
    private readonly giftCards: GiftCardPurchaseService,
    // ESP-04 M4a — only a Stripe provider enables Stripe outcome recovery
    // (absent when constructed directly, e.g. by older specs).
    @Inject(PAYMENT_PROVIDER)
    private readonly provider: PaymentProvider | null = null,
    // ESP-04 M5c — refund records kept true to Stripe (read-only).
    @Optional()
    private readonly refundReconciliation: RefundReconciliationService | null = null,
  ) {}

  // OFF by default: nothing is scheduled unless the deployment explicitly
  // sets PAYMENT_AUTO_RECOVERY_ENABLED=1.
  onModuleInit(): void {
    // ESP-04 M4b — a malformed abandonment deadline stops the process from
    // starting (fail closed), whether or not cleanup is switched on.
    abandonAfterMinutes();
    if (!automaticRecoveryEnabled()) return;
    this.timer = setInterval(() => {
      this.sweep().catch((error: unknown) => {
        this.logger.error(
          `automatic payment recovery sweep failed (${
            error instanceof Error ? error.name : 'unknown error'
          })`,
        );
      });
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // One bounded sweep. Returns what it did, for logs and tests. A sweep
  // already running in this process, or holding the lock in another, makes
  // this one a no-op.
  async sweep(
    now: Date = new Date(),
  ): Promise<{ swept: boolean; outcomes: RecoveryOutcome[] }> {
    if (this.sweeping) return { swept: false, outcomes: [] };
    this.sweeping = true;
    try {
      const result = await withSessionLock(SWEEP_LOCK_KEY, async () => {
        // ESP-03 PR 8 — payments that were never sent are closed first, so
        // their financial holds do not stay reserved.
        await this.checkout.abandonStrandedUnsentAttempts(now);
        // ESP-04 M4a — Stripe payments whose outcome is held are read back
        // from Stripe (and a lost creation replayed, within its window),
        // then unmatched Stripe events that now name a payment are
        // reconciled — both before fulfilment, so a payment found paid gets
        // its order in this same sweep.
        if (this.provider instanceof StripePaymentIntentProvider) {
          for (const candidate of await this.stripeCandidates(now)) {
            await this.recheckStripeOutcome(
              candidate.id,
              candidate.tenantId,
              { trigger: 'automatic' },
              now,
            );
          }
          await this.reconcileUnmatchedEvents(now);
          // ESP-04 M4b — then abandoned Stripe payments (waiting for a
          // customer who has long gone) are cancelled, only when Stripe
          // proves them unpaid, and only when its own switch is on.
          if (abandonedIntentCancelEnabled()) {
            for (const candidate of await this.abandonmentCandidates(now)) {
              await this.cancelAbandoned(candidate.id, candidate.tenantId, now);
            }
          }
          // ESP-04 M5c — refunds: each due payment's refunds read back from
          // Stripe and reconciled. Read-only: never creates, replays or
          // cancels a refund. Only with its own switch on.
          if (refundRecoveryEnabled() && this.refundReconciliation) {
            for (const candidate of await this.refundRecoveryCandidates(now)) {
              await this.refundReconciliation
                .reconcilePayment(candidate.tenantId, candidate.id, now)
                .catch((error: unknown) => {
                  this.logger.warn(
                    `payment ${candidate.id}: refund reconciliation failed (${
                      error instanceof Error ? error.name : 'unknown error'
                    })`,
                  );
                });
            }
          }
        }
        const due = await this.dueCandidates(now);
        const outcomes: RecoveryOutcome[] = [];
        for (const candidate of due) {
          outcomes.push(
            await this.recoverOne(candidate.id, candidate.tenantId, {
              trigger: 'automatic',
            }),
          );
        }
        return outcomes;
      });
      return result === null
        ? { swept: false, outcomes: [] }
        : { swept: true, outcomes: result };
    } finally {
      this.sweeping = false;
    }
  }

  // ESP-04 M5c — Stripe payments whose refunds are due a read-back (see the
  // REFUND_RECOVERY_* schedule), least recently reconciled first, at most one
  // batch.
  async refundRecoveryCandidates(
    now: Date = new Date(),
  ): Promise<{ id: string; tenantId: string }[]> {
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const days = (n: number) => ago(n * 24 * 60 * 60 * 1000);
    // Driven from the (small) sets of refunds and open obligations that need
    // it, never a scan of every payment; each with its own re-read interval.
    return this.prisma.$queryRaw<{ id: string; tenantId: string }[]>`
      WITH due AS (
        SELECT r."tenantId", r."paymentAttemptId" AS id,
               ${ago(REFUND_RECOVERY_UNRESOLVED_EVERY_MS)}::timestamp AS before
          FROM "PaymentRefund" r
         WHERE r.status IN ('REQUESTED', 'UNKNOWN', 'PENDING')
           AND r."createdAt" < ${ago(REFUND_RECOVERY_GRACE_MS)}
        UNION ALL
        SELECT r."tenantId", r."paymentAttemptId",
               ${ago(REFUND_RECOVERY_SUCCEEDED_EVERY_MS)}::timestamp
          FROM "PaymentRefund" r
         WHERE r.status = 'SUCCEEDED'
           AND r."succeededAt" > ${days(REFUND_RECOVERY_SUCCEEDED_FOR_DAYS)}
        UNION ALL
        SELECT ob."tenantId", ob."paymentAttemptId",
               ${ago(REFUND_RECOVERY_OBLIGATION_EVERY_MS)}::timestamp
          FROM "OrderRefundObligation" ob
         WHERE ob.status IN ('DUE', 'PROCESSING', 'FAILED')
           AND ob."createdAt" > ${days(REFUND_RECOVERY_OBLIGATION_FOR_DAYS)}
      )
      SELECT pa.id, pa."tenantId" FROM "PaymentAttempt" pa
        JOIN (SELECT "tenantId", id, max(before) AS before FROM due GROUP BY "tenantId", id) d
          ON d."tenantId" = pa."tenantId" AND d.id = pa.id
       WHERE pa.provider = 'stripe'
         AND pa."providerReference" IS NOT NULL
         AND pa."providerAccountId" IS NOT NULL
         AND (pa."refundsReconciledAt" IS NULL OR pa."refundsReconciledAt" < d.before)
       ORDER BY pa."refundsReconciledAt" ASC NULLS FIRST, pa.id ASC
       LIMIT ${SWEEP_BATCH_SIZE}`;
  }

  // Confirmed payments with no order whose saved checkout (or card-less
  // gift-card purchase) still exists, past the grace period, not resolved,
  // not set aside for people (a failure a retry cannot fix, or the automatic
  // attempts used up — both decided in SQL so they never fill the scan), and
  // due by the backoff schedule — oldest first, at most one batch.
  async dueCandidates(
    now: Date = new Date(),
  ): Promise<{ id: string; tenantId: string }[]> {
    const before = new Date(now.getTime() - RECOVERY_GRACE_MS);
    const due: { id: string; tenantId: string }[] = [];
    let after: { updatedAt: Date; id: string } | null = null;
    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      const rows = await this.candidatePage(before, after);
      if (rows.length === 0) break;
      const caseIds = rows.flatMap((r) => (r.caseId ? [r.caseId] : []));
      const events = caseIds.length
        ? await this.prisma.paymentReconciliationEvent.findMany({
            where: {
              caseId: { in: caseIds },
              action: { startsWith: 'RECOVERY_' },
            },
            select: {
              caseId: true,
              action: true,
              detail: true,
              createdAt: true,
            },
          })
        : [];
      const byCase = new Map<string, EventRow[]>();
      for (const event of events) {
        const list = byCase.get(event.caseId) ?? [];
        list.push(event);
        byCase.set(event.caseId, list);
      }
      for (const row of rows) {
        const history = recoveryHistoryOf(
          row.caseId ? (byCase.get(row.caseId) ?? []) : [],
          now,
        );
        if (history.inProgressSince) continue;
        const next = nextAutomaticAttemptAt(history, row.updatedAt, true);
        if (next === null || next.getTime() > now.getTime()) continue;
        due.push({ id: row.id, tenantId: row.tenantId });
        if (due.length >= SWEEP_BATCH_SIZE) return due;
      }
      if (rows.length < SWEEP_PAGE_SIZE) break;
      const last = rows[rows.length - 1];
      after = { updatedAt: last.updatedAt, id: last.id };
    }
    return due;
  }

  private candidatePage(
    before: Date,
    after: { updatedAt: Date; id: string } | null,
  ) {
    const afterUpdatedAt = after?.updatedAt ?? new Date(0);
    const afterId = after?.id ?? '';
    return this.prisma.$queryRaw<
      {
        id: string;
        tenantId: string;
        updatedAt: Date;
        caseId: string | null;
      }[]
    >`
      SELECT pa.id, pa."tenantId", pa."updatedAt", c.id AS "caseId"
      FROM "PaymentAttempt" pa
      LEFT JOIN "Order" o ON o."paymentAttemptId" = pa.id
      LEFT JOIN "CheckoutSnapshot" cs
        ON cs."paymentAttemptId" = pa.id AND cs."tenantId" = pa."tenantId"
      LEFT JOIN "GiftCardPurchase" gp
        ON gp."paymentAttemptId" = pa.id AND gp."tenantId" = pa."tenantId"
      LEFT JOIN "PaymentReconciliationCase" c
        ON c."paymentAttemptId" = pa.id AND c."tenantId" = pa."tenantId"
      WHERE pa.status::text = 'SUCCEEDED'
        AND pa."paymentState" = 'SUCCEEDED'
        AND o.id IS NULL
        AND (cs.id IS NOT NULL OR (gp.id IS NOT NULL AND gp."giftCardId" IS NULL))
        AND (c.id IS NULL OR c.status <> 'RESOLVED')
        AND pa."updatedAt" < ${before}
        AND (pa."updatedAt", pa.id) > (${afterUpdatedAt}, ${afterId})
        -- Set aside for people: the latest failure cannot be fixed by a retry.
        AND NOT EXISTS (
          SELECT 1 FROM "PaymentReconciliationEvent" f
          WHERE c.id IS NOT NULL
            AND f."caseId" = c.id AND f."tenantId" = c."tenantId"
            AND f.action = 'RECOVERY_FAILED'
            AND f.detail->>'retryable' = 'false'
            AND NOT EXISTS (
              SELECT 1 FROM "PaymentReconciliationEvent" g
              WHERE g."caseId" = c.id AND g."tenantId" = c."tenantId"
                AND g.action = 'RECOVERY_FAILED'
                AND (g."createdAt", g.id) > (f."createdAt", f.id)
            )
        )
        -- Set aside for people: the automatic attempts are used up.
        AND (
          c.id IS NULL OR (
            SELECT count(*) FROM "PaymentReconciliationEvent" s
            WHERE s."caseId" = c.id AND s."tenantId" = c."tenantId"
              AND s.action = 'RECOVERY_STARTED'
              AND s.detail->>'trigger' = 'automatic'
          ) < ${MAX_AUTOMATIC_ATTEMPTS}
        )
      ORDER BY pa."updatedAt" ASC, pa.id ASC
      LIMIT ${SWEEP_PAGE_SIZE}`;
  }

  // One recovery attempt for one payment of one business. Safe to call at
  // any time, from anywhere, any number of times.
  async recoverOne(
    paymentAttemptId: string,
    tenantId: string,
    request: RecoveryRequest,
  ): Promise<RecoveryOutcome> {
    try {
      const outcome = await withSessionLock(
        `esp03-payment-recovery:${tenantId}:${paymentAttemptId}`,
        () => this.recoverLocked(paymentAttemptId, tenantId, request),
      );
      return outcome ?? { kind: 'busy' };
    } catch (error) {
      // The lock could not be taken or the attempt could not be recorded
      // (the database is unavailable). Nothing was charged; the order path
      // is exactly-once on its own, and a started attempt without an outcome
      // counts toward the automatic cap once stale.
      this.logger.error(
        `payment attempt ${paymentAttemptId}: recovery could not run (${
          error instanceof Error ? error.name : 'unknown error'
        })`,
      );
      return { kind: 'failed', failure: 'TRANSIENT_ERROR', retryable: true };
    }
  }

  private async recoverLocked(
    paymentAttemptId: string,
    tenantId: string,
    request: RecoveryRequest,
  ): Promise<RecoveryOutcome> {
    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: { id: paymentAttemptId, tenantId },
      select: {
        id: true,
        status: true,
        paymentState: true,
        order: { select: { id: true } },
        checkoutSnapshot: { select: { id: true } },
        giftCardPurchase: { select: { id: true, giftCardId: true } },
      },
    });
    if (!attempt) return { kind: 'not_found' };
    if (
      String(attempt.status) !== 'SUCCEEDED' ||
      attempt.paymentState !== 'SUCCEEDED'
    ) {
      return { kind: 'not_confirmed' };
    }
    if (attempt.order || attempt.giftCardPurchase?.giftCardId) {
      await this.resolveIfFulfilled(paymentAttemptId, tenantId);
      return { kind: 'already_fulfilled' };
    }
    const giftCard = attempt.giftCardPurchase;
    if (!attempt.checkoutSnapshot && !giftCard) {
      return { kind: 'nothing_to_recover' };
    }

    const caseId = await this.ensureCase(paymentAttemptId, tenantId);
    const base: Record<string, string> = {
      source: 'recovery',
      trigger: request.trigger,
      paymentAttemptId,
      ...(request.platformOperatorId
        ? { platformOperatorId: request.platformOperatorId }
        : {}),
    };
    await this.event(tenantId, caseId, 'RECOVERY_STARTED', base);

    let outcome: RecoveryOutcome;
    try {
      if (giftCard) {
        const issued = await this.giftCards.recoverIssuance(
          paymentAttemptId,
          tenantId,
        );
        outcome = {
          kind: 'recovered',
          giftCardPurchaseId: issued.giftCardPurchaseId,
        };
      } else {
        const order = await this.checkout.recoverFulfilment(
          paymentAttemptId,
          tenantId,
        );
        outcome = { kind: 'recovered', orderId: order.orderId };
      }
    } catch (error) {
      const failure = classify(error, giftCard !== null);
      const retryable =
        failure === 'TRANSIENT_ERROR' || failure === 'GIFT_CARD_ISSUE_FAILED';
      await this.event(tenantId, caseId, 'RECOVERY_FAILED', {
        ...base,
        failure,
        retryable,
      });
      return { kind: 'failed', failure, retryable };
    }

    // The fulfilment transaction resolved the case with the record; this
    // also covers a record created meanwhile by another path.
    await this.resolveIfFulfilled(paymentAttemptId, tenantId);
    await this.event(tenantId, caseId, 'RECOVERY_SUCCEEDED', {
      ...base,
      ...(outcome.orderId ? { orderId: outcome.orderId } : {}),
      ...(outcome.giftCardPurchaseId
        ? { giftCardPurchaseId: outcome.giftCardPurchaseId }
        : {}),
    });
    return outcome;
  }

  // Resolves the open case only when the order or the issued card exists,
  // checked under the payment row lock (so it cannot race the fulfilment).
  private async resolveIfFulfilled(
    paymentAttemptId: string,
    tenantId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "PaymentAttempt"
        WHERE id = ${paymentAttemptId} AND "tenantId" = ${tenantId}
          AND status::text = 'SUCCEEDED' AND "paymentState" = 'SUCCEEDED'
        FOR UPDATE`;
      if (locked.length !== 1) return;
      const order = await tx.order.findFirst({
        where: { paymentAttemptId, tenantId },
        select: { id: true },
      });
      const purchase = order
        ? null
        : await tx.giftCardPurchase.findFirst({
            where: { paymentAttemptId, tenantId, giftCardId: { not: null } },
            select: { id: true },
          });
      if (!order && !purchase) return;
      await resolveCaseAsFulfilled(tx, tenantId, paymentAttemptId, {
        source: 'recovery',
        ...(order ? { orderId: order.id } : {}),
        ...(purchase ? { giftCardPurchaseId: purchase.id } : {}),
      });
    });
  }

  // --- ESP-04 M4a: Stripe outcome recovery -----------------------------------

  // One Stripe outcome recovery of one payment of one business, under the
  // SAME per-payment lock as fulfilment recovery (they never run together on
  // a payment). Safe to call at any time, any number of times: it never
  // charges, never creates a payment or a second intent, and moves the
  // payment only on Stripe's read-back.
  async recheckStripeOutcome(
    paymentAttemptId: string,
    tenantId: string,
    request: { trigger: StripeRecheckTrigger; platformOperatorId?: string },
    now: Date = new Date(),
  ): Promise<StripeRecheckOutcome> {
    try {
      const outcome = await withSessionLock(
        `esp03-payment-recovery:${tenantId}:${paymentAttemptId}`,
        () =>
          this.stripeOutcomeLocked(paymentAttemptId, tenantId, request, now),
      );
      return outcome ?? { kind: 'busy' };
    } catch (error) {
      this.logger.error(
        `payment attempt ${paymentAttemptId}: Stripe outcome recovery could not run (${
          error instanceof Error ? error.name : 'unknown error'
        })`,
      );
      return { kind: 'failed', failure: 'STRIPE_UNREADABLE', retryable: true };
    }
  }

  private async stripeOutcomeLocked(
    paymentAttemptId: string,
    tenantId: string,
    request: { trigger: StripeRecheckTrigger; platformOperatorId?: string },
    now: Date,
  ): Promise<StripeRecheckOutcome> {
    const provider = this.provider;
    if (!(provider instanceof StripePaymentIntentProvider)) {
      return { kind: 'not_applicable' };
    }
    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: { id: paymentAttemptId, tenantId },
    });
    if (!attempt) return { kind: 'not_found' };
    const held = (RECOVERABLE_HELD_STATES as readonly string[]).includes(
      attempt.paymentState ?? '',
    );
    // A payment waiting for its customer is rechecked only on request
    // (support, or a Stripe event naming it); the sweeper leaves it alone.
    const waiting =
      attempt.paymentState === 'REQUIRES_CUSTOMER_ACTION' &&
      request.trigger !== 'automatic';
    if (
      attempt.provider !== 'stripe' ||
      String(attempt.status) !== 'PENDING' ||
      (!held && !waiting)
    ) {
      return { kind: 'not_applicable' };
    }

    const caseId = await this.ensureOutcomeCase(
      paymentAttemptId,
      tenantId,
      attempt.paymentState === 'CHARGING'
        ? 'CHARGE_STRANDED'
        : 'PROVIDER_OUTCOME_UNKNOWN',
    );
    const base: Record<string, string> = {
      source: 'stripe-recovery',
      trigger: request.trigger,
      paymentAttemptId,
      ...(request.platformOperatorId
        ? { platformOperatorId: request.platformOperatorId }
        : {}),
    };
    await this.event(tenantId, caseId, 'STRIPE_RECHECK_STARTED', base);
    const fail = async (
      failure: StripeRecheckFailure,
      retryable: boolean,
    ): Promise<StripeRecheckOutcome> => {
      await this.event(tenantId, caseId, 'STRIPE_RECHECK_FAILED', {
        ...base,
        failure,
        retryable,
      });
      return { kind: 'failed', failure, retryable };
    };
    const settled = async (
      result: 'PAID' | 'WAITING_FOR_CUSTOMER' | 'PROCESSING' | 'NOT_CHARGED',
    ): Promise<StripeRecheckOutcome> => {
      await this.event(tenantId, caseId, 'STRIPE_RECHECK_SUCCEEDED', {
        ...base,
        outcome: result,
      });
      return { kind: 'settled', result };
    };

    // Only ever the account the payment was created on, still the
    // business's own.
    const account = await paymentAccountForAttempt(this.prisma, attempt);
    if (account === null || attempt.providerAccountId === null) {
      return fail(
        attempt.providerAccountId === null
          ? 'STRIPE_ACCOUNT_MISSING'
          : 'STRIPE_ACCOUNT_MISMATCH',
        false,
      );
    }

    if (!held) {
      // Live: the customer's own check path (read-back, conditional moves,
      // the order exactly once).
      const answer = await this.checkout.reconcileProviderPayment(
        tenantId,
        paymentAttemptId,
        STRIPE_RECHECK_TIMEOUT_MS,
      );
      if (answer === 'retry') return fail('STRIPE_UNREADABLE', true);
      const current = await this.prisma.paymentAttempt.findFirstOrThrow({
        where: { id: paymentAttemptId, tenantId },
        select: { status: true, paymentState: true },
      });
      return settled(resultOfState(current));
    }

    let reference = attempt.providerReference;
    if (reference === null) {
      const replay = await replayPaymentIntentCreation(
        this.prisma,
        provider,
        attempt,
        account,
        now,
        STRIPE_RECHECK_TIMEOUT_MS,
      );
      switch (replay.kind) {
        case 'linked':
          reference = replay.reference;
          break;
        case 'expired':
          return fail('STRIPE_CREATE_EXPIRED', false);
        case 'conflict':
          return fail('STRIPE_IDEMPOTENCY_CONFLICT', false);
        case 'no-account':
          return fail('STRIPE_ACCOUNT_MISSING', false);
        case 'unreadable':
          return fail('STRIPE_UNREADABLE', true);
        case 'changed':
          return fail('STRIPE_STATE_CHANGED', true);
      }
    }

    const readBack: ReadBack = await readBackHeldPayment(
      this.prisma,
      provider,
      { ...attempt, providerReference: reference },
      account,
      STRIPE_RECHECK_TIMEOUT_MS,
    );
    switch (readBack.kind) {
      case 'unreadable':
        return fail('STRIPE_UNREADABLE', true);
      case 'changed':
        return fail('STRIPE_STATE_CHANGED', true);
      case 'mismatch':
        return fail('STRIPE_AMOUNT_MISMATCH', false);
      case 'paid':
      case 'not-charged': {
        // The order exactly once (paid), or the saved checkout removed (not
        // charged) — the same idempotent path a webhook takes.
        const followed = await this.checkout
          .reconcileProviderPayment(
            tenantId,
            paymentAttemptId,
            STRIPE_RECHECK_TIMEOUT_MS,
          )
          .catch(() => 'retry' as const);
        if (followed === 'retry' && readBack.kind === 'paid') {
          // Paid, but its order is not created (or flagged) yet: NOT settled
          // for whoever asked (an unmatched event stays open, with a case);
          // fulfilment recovery creates the order exactly once.
          return fail('STRIPE_FULFILMENT_PENDING', true);
        }
        return settled(readBack.kind === 'paid' ? 'PAID' : 'NOT_CHARGED');
      }
      case 'waiting':
        return settled('WAITING_FOR_CUSTOMER');
      case 'processing':
        return settled('PROCESSING');
    }
  }

  // Held Stripe payments due a Stripe outcome recovery: past their grace
  // (CHARGING longer: the first request may still be talking to Stripe),
  // case not resolved, not set aside for people (the latest Stripe recheck
  // failed in a way a retry cannot fix, or the automatic attempts are used
  // up — both decided in SQL), and due by the backoff — oldest first, one
  // batch at most.
  async stripeCandidates(
    now: Date = new Date(),
  ): Promise<{ id: string; tenantId: string }[]> {
    const before = new Date(now.getTime() - RECOVERY_GRACE_MS);
    const chargingBefore = new Date(now.getTime() - STRIPE_CHARGING_GRACE_MS);
    const due: { id: string; tenantId: string }[] = [];
    let after: { updatedAt: Date; id: string } | null = null;
    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      const afterUpdatedAt: Date = after?.updatedAt ?? new Date(0);
      const afterId: string = after?.id ?? '';
      const rows: {
        id: string;
        tenantId: string;
        updatedAt: Date;
        caseId: string | null;
      }[] = await this.prisma.$queryRaw<
        {
          id: string;
          tenantId: string;
          updatedAt: Date;
          caseId: string | null;
        }[]
      >`
        SELECT pa.id, pa."tenantId", pa."updatedAt", c.id AS "caseId"
        FROM "PaymentAttempt" pa
        LEFT JOIN "PaymentReconciliationCase" c
          ON c."paymentAttemptId" = pa.id AND c."tenantId" = pa."tenantId"
        WHERE pa.provider = 'stripe'
          AND pa.status::text = 'PENDING'
          AND pa."paymentState" IN ('CHARGING', 'UNKNOWN', 'AWAITING_CONFIRMATION')
          AND (
            (pa."paymentState" = 'CHARGING' AND pa."updatedAt" < ${chargingBefore})
            OR (pa."paymentState" <> 'CHARGING' AND pa."updatedAt" < ${before})
          )
          AND (c.id IS NULL OR c.status <> 'RESOLVED')
          AND (pa."updatedAt", pa.id) > (${afterUpdatedAt}, ${afterId})
          -- Set aside for people: the latest Stripe recheck outcome is a
          -- failure a retry cannot fix.
          AND NOT EXISTS (
            SELECT 1 FROM "PaymentReconciliationEvent" f
            WHERE c.id IS NOT NULL
              AND f."caseId" = c.id AND f."tenantId" = c."tenantId"
              AND f.action = 'STRIPE_RECHECK_FAILED'
              AND f.detail->>'retryable' = 'false'
              AND NOT EXISTS (
                SELECT 1 FROM "PaymentReconciliationEvent" g
                WHERE g."caseId" = c.id AND g."tenantId" = c."tenantId"
                  AND g.action IN ('STRIPE_RECHECK_FAILED', 'STRIPE_RECHECK_SUCCEEDED')
                  AND (g."createdAt", g.id) > (f."createdAt", f.id)
              )
          )
          -- Set aside for people: the automatic attempts are used up.
          AND (
            c.id IS NULL OR (
              SELECT count(*) FROM "PaymentReconciliationEvent" s
              WHERE s."caseId" = c.id AND s."tenantId" = c."tenantId"
                AND s.action = 'STRIPE_RECHECK_STARTED'
                AND s.detail->>'trigger' = 'automatic'
            ) < ${MAX_AUTOMATIC_ATTEMPTS}
          )
        ORDER BY pa."updatedAt" ASC, pa.id ASC
        LIMIT ${SWEEP_PAGE_SIZE}`;
      if (rows.length === 0) break;
      const caseIds = rows.flatMap((r) => (r.caseId ? [r.caseId] : []));
      const events = caseIds.length
        ? await this.prisma.paymentReconciliationEvent.findMany({
            where: {
              caseId: { in: caseIds },
              action: { startsWith: 'STRIPE_RECHECK_' },
            },
            select: {
              caseId: true,
              action: true,
              detail: true,
              createdAt: true,
            },
          })
        : [];
      for (const row of rows) {
        const history = recoveryHistoryOf(
          events.filter((e) => e.caseId === row.caseId),
          now,
          'STRIPE_RECHECK',
        );
        if (history.inProgressSince) continue;
        const next = nextAutomaticAttemptAt(history, row.updatedAt, true);
        if (next === null || next.getTime() > now.getTime()) continue;
        due.push({ id: row.id, tenantId: row.tenantId });
        if (due.length >= SWEEP_BATCH_SIZE) return due;
      }
      if (rows.length < SWEEP_PAGE_SIZE) break;
      const last = rows[rows.length - 1];
      after = { updatedAt: last.updatedAt, id: last.id };
    }
    return due;
  }

  // Corrected decision 7 — UNMATCHED Stripe payment events (a verified
  // event for one of our accounts that named no payment when it arrived)
  // that now name one: the payment is reconciled HERE, through the same
  // idempotent paths (Stripe outcome recovery for a held payment, the
  // webhook's read-back for any other), whether or not the event re-drive is
  // on and without waiting for Stripe to deliver anything again. Linking is
  // only ever through OUR records: the event's account must be one of our
  // businesses' accounts, and that business's Stripe payment must name the
  // event's intent on that same account — never the event's metadata.
  // Bounded: the least recently tried first (never-tried before anything),
  // backoff and a cap per event, so events still failing never crowd out
  // the ones behind them.
  async reconcileUnmatchedEvents(now: Date = new Date()): Promise<number> {
    const since = new Date(now.getTime() - UNMATCHED_EVENT_WINDOW_MS);
    const rows = await this.prisma.$queryRaw<
      {
        eventId: string;
        attemptId: string;
        tenantId: string;
        attempts: number;
        lastAttemptAt: Date | null;
      }[]
    >`
      SELECT e.id AS "eventId", pa.id AS "attemptId", pa."tenantId",
             e.attempts, e."lastAttemptAt"
      FROM "RestaurantPaymentProviderEvent" e
      JOIN "TenantPaymentAccount" a
        ON a."externalAccountId" = e."externalAccountId"
       AND a.provider = 'stripe' AND a.livemode = false
      JOIN "PaymentAttempt" pa
        ON pa."tenantId" = a."tenantId"
       AND pa.provider = 'stripe'
       AND pa."providerReference" = e."externalObjectId"
       AND pa."providerAccountId" = e."externalAccountId"
      WHERE e.provider = 'stripe'
        AND e.status = 'UNMATCHED'
        AND e.livemode = false
        AND e.type = ANY(${[...PAYMENT_EVENT_TYPES]}::text[])
        AND e."receivedAt" > ${since}
        AND e.attempts < ${UNMATCHED_EVENT_MAX_ATTEMPTS}
      ORDER BY e."lastAttemptAt" ASC NULLS FIRST, e."receivedAt" ASC, e.id ASC
      LIMIT ${UNMATCHED_EVENT_SCAN}`;
    let processed = 0;
    for (const row of rows) {
      if (processed >= UNMATCHED_EVENT_BATCH) break;
      if (
        row.lastAttemptAt !== null &&
        now.getTime() - row.lastAttemptAt.getTime() <
          unmatchedBackoffMs(row.attempts)
      ) {
        continue;
      }
      // Claimed for this try (counted from the start, so an interrupted try
      // backs off too); skipped if another process finished it meanwhile.
      const claimed =
        await this.prisma.restaurantPaymentProviderEvent.updateMany({
          where: { id: row.eventId, status: 'UNMATCHED' },
          data: { attempts: { increment: 1 }, lastAttemptAt: now },
        });
      if (claimed.count !== 1) continue;
      processed += 1;
      if (await this.reconcileLinkedPayment(row.attemptId, row.tenantId, now)) {
        await this.prisma.restaurantPaymentProviderEvent.updateMany({
          where: { id: row.eventId, status: 'UNMATCHED' },
          data: {
            status: 'PROCESSED',
            outcome: 'LINKED_BY_RECOVERY',
            processedAt: new Date(),
          },
        });
      } else {
        // Money may have moved: visible to people meanwhile.
        await openReconciliationCase(
          this.prisma,
          row.attemptId,
          'PROVIDER_EVENT_NOT_SETTLED',
          { outcome: 'unknown' },
        );
      }
    }
    return processed;
  }

  // True when the payment an unmatched event names is settled from Stripe's
  // own answer (or was already final).
  private async reconcileLinkedPayment(
    paymentAttemptId: string,
    tenantId: string,
    now: Date,
  ): Promise<boolean> {
    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: { id: paymentAttemptId, tenantId },
      select: { status: true, paymentState: true },
    });
    if (!attempt) return false;
    if (
      String(attempt.status) === 'PENDING' &&
      (RECOVERABLE_HELD_STATES as readonly string[]).includes(
        attempt.paymentState ?? '',
      )
    ) {
      const outcome = await this.recheckStripeOutcome(
        paymentAttemptId,
        tenantId,
        { trigger: 'stripe_event' },
        now,
      );
      return outcome.kind === 'settled';
    }
    // Live, paid or closed: the webhook's own idempotent read-back (the
    // order exactly once), under the payment's lock.
    const answer = await withSessionLock(
      `esp03-payment-recovery:${tenantId}:${paymentAttemptId}`,
      () =>
        this.checkout.reconcileProviderPayment(
          tenantId,
          paymentAttemptId,
          STRIPE_RECHECK_TIMEOUT_MS,
        ),
    ).catch(() => null);
    return answer === 'settled';
  }

  // The payment's case for a Stripe outcome recovery (opened first if a
  // crash left the held payment without one).
  // --- ESP-04 M4b: abandoned Stripe payment cleanup -----------------------------

  // Stripe payments waiting for a customer who has long gone: no verified
  // activity (heartbeat) and created for at least the deadline — inactivity
  // measured from the LATER of the two. Case not resolved, not set aside for
  // people (decided in SQL, so they never fill the scan), due by the
  // backoff; oldest first, one batch at most, keyset paging.
  async abandonmentCandidates(
    now: Date = new Date(),
  ): Promise<{ id: string; tenantId: string }[]> {
    const cutoff = new Date(now.getTime() - abandonAfterMinutes() * 60_000);
    const due: { id: string; tenantId: string }[] = [];
    let after: { createdAt: Date; id: string } | null = null;
    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      const afterCreatedAt: Date = after?.createdAt ?? new Date(0);
      const afterId: string = after?.id ?? '';
      const rows: {
        id: string;
        tenantId: string;
        createdAt: Date;
        caseId: string | null;
      }[] = await this.prisma.$queryRaw<
        {
          id: string;
          tenantId: string;
          createdAt: Date;
          caseId: string | null;
        }[]
      >`
        SELECT pa.id, pa."tenantId", pa."createdAt", c.id AS "caseId"
        FROM "PaymentAttempt" pa
        LEFT JOIN "PaymentReconciliationCase" c
          ON c."paymentAttemptId" = pa.id AND c."tenantId" = pa."tenantId"
        WHERE pa.provider = 'stripe'
          AND pa.status::text = 'PENDING'
          AND pa."paymentState" = 'REQUIRES_CUSTOMER_ACTION'
          AND pa."providerReference" IS NOT NULL
          AND pa."providerAccountId" IS NOT NULL
          AND pa."createdAt" < ${cutoff}
          AND COALESCE(pa."customerActiveAt", pa."createdAt") < ${cutoff}
          AND (c.id IS NULL OR c.status <> 'RESOLVED')
          AND (pa."createdAt", pa.id) > (${afterCreatedAt}, ${afterId})
          -- Set aside for people: the latest abandonment outcome is a
          -- failure a retry cannot fix (e.g. a stale authentication).
          AND NOT EXISTS (
            SELECT 1 FROM "PaymentReconciliationEvent" f
            WHERE c.id IS NOT NULL
              AND f."caseId" = c.id AND f."tenantId" = c."tenantId"
              AND f.action = 'STRIPE_ABANDON_FAILED'
              AND f.detail->>'retryable' = 'false'
              AND NOT EXISTS (
                SELECT 1 FROM "PaymentReconciliationEvent" g
                WHERE g."caseId" = c.id AND g."tenantId" = c."tenantId"
                  AND g.action IN ('STRIPE_ABANDON_FAILED', 'STRIPE_ABANDON_SUCCEEDED')
                  AND (g."createdAt", g.id) > (f."createdAt", f.id)
              )
          )
          -- Set aside for people: the automatic attempts since the last
          -- settled abandonment are used up (counted as recoveryHistoryOf
          -- counts them for the backoff).
          AND (
            c.id IS NULL OR (
              SELECT count(*) FROM "PaymentReconciliationEvent" s
              WHERE s."caseId" = c.id AND s."tenantId" = c."tenantId"
                AND s.action = 'STRIPE_ABANDON_STARTED'
                AND s.detail->>'trigger' = 'automatic'
                AND NOT EXISTS (
                  SELECT 1 FROM "PaymentReconciliationEvent" ok
                  WHERE ok."caseId" = c.id AND ok."tenantId" = c."tenantId"
                    AND ok.action = 'STRIPE_ABANDON_SUCCEEDED'
                    AND (ok."createdAt", ok.id) > (s."createdAt", s.id)
                )
            ) < ${MAX_AUTOMATIC_ATTEMPTS}
          )
        ORDER BY pa."createdAt" ASC, pa.id ASC
        LIMIT ${SWEEP_PAGE_SIZE}`;
      if (rows.length === 0) break;
      const caseIds = rows.flatMap((r) => (r.caseId ? [r.caseId] : []));
      const events = caseIds.length
        ? await this.prisma.paymentReconciliationEvent.findMany({
            where: {
              caseId: { in: caseIds },
              action: { startsWith: 'STRIPE_ABANDON_' },
            },
            select: {
              caseId: true,
              action: true,
              detail: true,
              createdAt: true,
            },
          })
        : [];
      for (const row of rows) {
        const history = recoveryHistoryOf(
          events.filter((e) => e.caseId === row.caseId),
          now,
          'STRIPE_ABANDON',
        );
        if (history.inProgressSince) continue;
        if (
          history.lastAttemptAt !== null &&
          now.getTime() - history.lastAttemptAt.getTime() <
            backoffAfter(history.automaticAttempts)
        ) {
          continue;
        }
        due.push({ id: row.id, tenantId: row.tenantId });
        if (due.length >= SWEEP_BATCH_SIZE) return due;
      }
      if (rows.length < SWEEP_PAGE_SIZE) break;
      const last = rows[rows.length - 1];
      after = { createdAt: last.createdAt, id: last.id };
    }
    return due;
  }

  // Cancels ONE abandoned Stripe payment if — and only if — Stripe proves it
  // unpaid, under the SAME per-payment lock as every other recovery of it.
  // Holds are released only by Stripe's read-back AFTER the cancel request
  // (cancelled, nothing received, this account and intent), through the
  // payment's conditional transition and the database's hold guard. Never
  // on elapsed time, a cancel answer, an error or a browser.
  async cancelAbandoned(
    paymentAttemptId: string,
    tenantId: string,
    now: Date = new Date(),
  ): Promise<AbandonOutcome> {
    try {
      const outcome = await withSessionLock(
        `esp03-payment-recovery:${tenantId}:${paymentAttemptId}`,
        () => this.abandonLocked(paymentAttemptId, tenantId, now),
      );
      return outcome ?? { kind: 'busy' };
    } catch (error) {
      this.logger.error(
        `payment attempt ${paymentAttemptId}: abandoned payment cleanup could not run (${
          error instanceof Error ? error.name : 'unknown error'
        })`,
      );
      return { kind: 'failed', failure: 'STRIPE_UNREADABLE', retryable: true };
    }
  }

  private async abandonLocked(
    paymentAttemptId: string,
    tenantId: string,
    now: Date,
  ): Promise<AbandonOutcome> {
    const provider = this.provider;
    if (!(provider instanceof StripePaymentIntentProvider)) {
      return { kind: 'not_applicable' };
    }
    const cutoff = now.getTime() - abandonAfterMinutes() * 60_000;
    const load = () =>
      this.prisma.paymentAttempt.findFirst({
        where: { id: paymentAttemptId, tenantId },
      });
    const inactive = (a: Awaited<ReturnType<typeof load>>) =>
      a !== null &&
      a.provider === 'stripe' &&
      String(a.status) === 'PENDING' &&
      a.paymentState === 'REQUIRES_CUSTOMER_ACTION' &&
      a.providerReference !== null &&
      a.providerAccountId !== null &&
      a.createdAt.getTime() < cutoff &&
      (a.customerActiveAt ?? a.createdAt).getTime() < cutoff;

    // 1. The database: still waiting for its customer, and still inactive.
    const attempt = await load();
    if (!attempt || !inactive(attempt)) return { kind: 'not_eligible' };
    const reference = attempt.providerReference!;

    const caseId = await this.ensureOutcomeCase(
      paymentAttemptId,
      tenantId,
      'STRIPE_ABANDONED_CHECKOUT',
    );
    const base: Record<string, string> = {
      source: 'stripe-abandonment',
      trigger: 'automatic',
      paymentAttemptId,
    };
    await this.event(tenantId, caseId, 'STRIPE_ABANDON_STARTED', base);
    const fail = async (
      failure: AbandonFailure,
      retryable: boolean,
    ): Promise<AbandonOutcome> => {
      await this.event(tenantId, caseId, 'STRIPE_ABANDON_FAILED', {
        ...base,
        failure,
        retryable,
      });
      return { kind: 'failed', failure, retryable };
    };
    const settled = async (result: AbandonResult): Promise<AbandonOutcome> => {
      await this.event(tenantId, caseId, 'STRIPE_ABANDON_SUCCEEDED', {
        ...base,
        outcome: result,
      });
      return { kind: 'settled', result };
    };

    // Only ever the account the payment was created on, still the
    // business's own.
    const account = await paymentAccountForAttempt(this.prisma, attempt);
    if (account === null) return fail('STRIPE_ACCOUNT_MISMATCH', false);

    // 2. Stripe: what the intent is now.
    const facts = await boundedCall(
      () => provider.abandonmentFactsFor({ reference, account }),
      STRIPE_RECHECK_TIMEOUT_MS,
    ).catch(() => null);
    if (!facts) return fail('STRIPE_UNREADABLE', true);

    if (
      facts.status === 'requires_action' ||
      facts.status === 'requires_confirmation'
    ) {
      // An authentication (3-D Secure) that may still be under way: NEVER
      // cancelled automatically. Held and visible to people.
      await this.event(tenantId, caseId, 'STRIPE_AUTHENTICATION_STALE', {
        source: 'stripe-abandonment',
        paymentAttemptId,
        reasonCode: 'STRIPE_AUTHENTICATION_STALE',
      });
      return fail('STRIPE_AUTHENTICATION_STALE', false);
    }
    if (facts.status !== 'requires_payment_method') {
      // Paid, processing, already cancelled or anything else: never
      // cancelled here — the payment is settled from Stripe's answer through
      // the customer's own check path (the order exactly once if paid).
      return this.settleFromStripe(tenantId, paymentAttemptId, settled, fail);
    }
    const provablyUnpaid = (f: AbandonmentFacts) =>
      f.status === 'requires_payment_method' &&
      f.amount === attempt.amount &&
      f.currency === attempt.currency.toUpperCase() &&
      f.amountReceived === 0 &&
      !f.nextActionPending &&
      (f.latestCharge === 'none' || f.latestCharge === 'failed');
    if (!provablyUnpaid(facts)) {
      // Another amount, money received, an action pending, or a charge that
      // is (or may be) pending or succeeded: not provably unpaid. Held.
      return fail('STRIPE_ABANDON_UNSAFE', false);
    }

    // 3. The final check, just before cancelling: still waiting, still
    // inactive (a heartbeat since step 1 keeps the checkout open) ...
    if (!inactive(await load())) return settled('STILL_ACTIVE');
    // ... and Stripe read AGAIN: a customer who confirmed in the browser since
    // step 2 (moving the intent to 3-D Secure or processing) is never
    // cancelled. Stripe has no conditional cancel, so the window left is the
    // single round trip between this read and the cancel below.
    const latest = await boundedCall(
      () => provider.abandonmentFactsFor({ reference, account }),
      STRIPE_RECHECK_TIMEOUT_MS,
    ).catch(() => null);
    if (!latest) return fail('STRIPE_UNREADABLE', true);
    if (
      latest.status === 'requires_action' ||
      latest.status === 'requires_confirmation'
    ) {
      // The customer is authenticating right now: not abandoned. Held,
      // looked at again only after a fresh period of inactivity.
      return settled('STILL_ACTIVE');
    }
    if (latest.status !== 'requires_payment_method') {
      // Paid or processing since step 2: settled from Stripe's answer.
      return this.settleFromStripe(tenantId, paymentAttemptId, settled, fail);
    }
    if (!provablyUnpaid(latest)) return fail('STRIPE_ABANDON_UNSAFE', false);

    // 4. Cancel (any answer is only a hint), then 5. ALWAYS read back.
    await boundedCall(
      () =>
        provider.cancelPaymentIntent({
          reference,
          account,
          idempotencyKey: `${attempt.idempotencyKey}:abandon`,
        }),
      STRIPE_RECHECK_TIMEOUT_MS,
    ).catch(() => null);
    return this.settleFromStripe(tenantId, paymentAttemptId, settled, fail);
  }

  // Reads the payment back from Stripe through the customer's own check path
  // (conditional transitions; cancelled with nothing received closes it and
  // the database releases its holds; paid creates its order exactly once)
  // and reports where it now stands.
  private async settleFromStripe(
    tenantId: string,
    paymentAttemptId: string,
    settled: (result: AbandonResult) => Promise<AbandonOutcome>,
    fail: (
      failure: AbandonFailure,
      retryable: boolean,
    ) => Promise<AbandonOutcome>,
  ): Promise<AbandonOutcome> {
    const answer = await this.checkout
      .reconcileProviderPayment(
        tenantId,
        paymentAttemptId,
        STRIPE_RECHECK_TIMEOUT_MS,
      )
      .catch(() => 'retry' as const);
    const current = await this.prisma.paymentAttempt.findFirstOrThrow({
      where: { id: paymentAttemptId, tenantId },
      select: { status: true, paymentState: true },
    });
    const status = String(current.status);
    if (status === 'FAILED' || status === 'DECLINED') {
      // Closed by the read-back's own proof-gated transition; reported as
      // cancelled only when this read-back is what settled it.
      return answer === 'settled'
        ? settled('CANCELLED')
        : fail('STRIPE_UNREADABLE', true);
    }
    if (status === 'SUCCEEDED') {
      return answer === 'settled'
        ? settled('PAID')
        : fail('STRIPE_FULFILMENT_PENDING', true);
    }
    if (current.paymentState === 'AWAITING_CONFIRMATION') {
      return settled('PROCESSING');
    }
    // Still waiting (Stripe unreadable, or the cancel did not take): unchanged,
    // holds kept, tried again later.
    return fail(
      answer === 'retry' ? 'STRIPE_UNREADABLE' : 'STRIPE_CANCEL_UNCONFIRMED',
      true,
    );
  }

  private async ensureOutcomeCase(
    paymentAttemptId: string,
    tenantId: string,
    reasonCode: string,
  ): Promise<string> {
    const find = () =>
      this.prisma.paymentReconciliationCase.findUnique({
        where: { tenantId_paymentAttemptId: { tenantId, paymentAttemptId } },
        select: { id: true },
      });
    const existing = await find();
    if (existing) return existing.id;
    await openReconciliationCase(this.prisma, paymentAttemptId, reasonCode, {
      outcome: 'unknown',
    });
    const opened = await find();
    if (!opened) {
      throw new Error('The reconciliation case could not be opened.');
    }
    return opened.id;
  }

  private async ensureCase(
    paymentAttemptId: string,
    tenantId: string,
  ): Promise<string> {
    const find = () =>
      this.prisma.paymentReconciliationCase.findUnique({
        where: { tenantId_paymentAttemptId: { tenantId, paymentAttemptId } },
        select: { id: true },
      });
    const existing = await find();
    if (existing) return existing.id;
    // A confirmed payment without its order and without a case: the first
    // request stopped before it could record anything.
    await openReconciliationCase(
      this.prisma,
      paymentAttemptId,
      'FULFILMENT_INCOMPLETE',
      { outcome: 'succeeded' },
    );
    const opened = await find();
    if (!opened) {
      throw new Error('The reconciliation case could not be opened.');
    }
    return opened.id;
  }

  private async event(
    tenantId: string,
    caseId: string,
    action: string,
    detail: Prisma.InputJsonObject,
  ): Promise<void> {
    await this.prisma.paymentReconciliationEvent.create({
      data: { tenantId, caseId, actorKind: 'SYSTEM', action, detail },
    });
  }
}

function classify(error: unknown, giftCard: boolean): RecoveryFailure {
  if (giftCard) return 'GIFT_CARD_ISSUE_FAILED';
  if (error instanceof UnreadableCheckoutSnapshotError) {
    return 'SNAPSHOT_UNREADABLE';
  }
  // A business reason the order cannot be created from the saved checkout
  // (the cart, price, discount or location changed; the payment was not
  // confirmed): retrying will not change it — people must look. A 5xx (the
  // order number could not be allocated, the database is unavailable) is
  // worth retrying.
  if (error instanceof HttpException && error.getStatus() < 500) {
    return 'FULFILMENT_REJECTED';
  }
  return 'TRANSIENT_ERROR';
}
