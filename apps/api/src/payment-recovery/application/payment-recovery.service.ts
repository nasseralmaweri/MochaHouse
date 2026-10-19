import {
  HttpException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Client } from 'pg';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { CheckoutService } from '../../orders/application/checkout.service';
import { UnreadableCheckoutSnapshotError } from '../../orders/application/checkout-snapshot';
import { GiftCardPurchaseService } from '../../gift-cards/application/gift-card-purchase.service';
import {
  openReconciliationCase,
  resolveCaseAsFulfilled,
} from '../../payment/payment-charge';

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
  lastFailure: RecoveryFailure | null;
  lastFailureRetryable: boolean;
  lastFailureAt: Date | null;
  // A RECOVERY_STARTED newer than every outcome and not stale.
  inProgressSince: Date | null;
}

type EventRow = { action: string; detail: unknown; createdAt: Date };

export function recoveryHistoryOf(
  events: readonly EventRow[],
  now: Date = new Date(),
): RecoveryHistory {
  const sorted = [...events].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  let automaticAttempts = 0;
  let lastAttemptAt: Date | null = null;
  let lastFailure: RecoveryFailure | null = null;
  let lastFailureRetryable = false;
  let lastFailureAt: Date | null = null;
  let openStart: Date | null = null;
  for (const event of sorted) {
    const detail = (event.detail ?? {}) as Record<string, unknown>;
    if (event.action === 'RECOVERY_STARTED') {
      openStart = event.createdAt;
      lastAttemptAt = event.createdAt;
      if (detail.trigger === 'automatic') automaticAttempts += 1;
    } else if (event.action === 'RECOVERY_FAILED') {
      openStart = null;
      lastAttemptAt = event.createdAt;
      lastFailure =
        typeof detail.failure === 'string'
          ? (detail.failure as RecoveryFailure)
          : 'TRANSIENT_ERROR';
      lastFailureRetryable = detail.retryable === true;
      lastFailureAt = event.createdAt;
    } else if (
      event.action === 'RECOVERY_SUCCEEDED' ||
      event.action === 'RESOLVED'
    ) {
      openStart = null;
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

// A connection string for a plain `pg` client: Prisma's own `schema`
// parameter is not a PostgreSQL option.
function lockConnectionString(): string {
  const raw = process.env.DATABASE_URL!;
  try {
    const url = new URL(raw);
    url.searchParams.delete('schema');
    return url.toString();
  } catch {
    return raw;
  }
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
  ) {}

  // OFF by default: nothing is scheduled unless the deployment explicitly
  // sets PAYMENT_AUTO_RECOVERY_ENABLED=1.
  onModuleInit(): void {
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

// Runs `fn` holding a session-level advisory lock on a dedicated
// connection; null (and `fn` not run) when another holder has it. The lock
// is released when `fn` ends, or by PostgreSQL when the connection drops.
async function withSessionLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const client = new Client({ connectionString: lockConnectionString() });
  // A dropped lock connection is surfaced by the next query; never crash.
  client.on('error', () => undefined);
  await client.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [key],
    );
    if (rows[0]?.locked !== true) return null;
    try {
      return await fn();
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])
        .catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
