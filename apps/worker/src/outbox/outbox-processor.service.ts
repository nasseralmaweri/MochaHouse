import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { runWithTenantContext } from '@mocha-house/database';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { redactEmails } from '../notifications/notification-dispatch.service';
import type {
  ClaimedOutboxEvent,
  DispatchOutcome,
} from '../notifications/notification-dispatch.service';
import { WorkerTenantContextFactory } from '../tenancy/worker-tenant-context.factory';
import { OUTBOX_CONFIG, type OutboxConfig } from './outbox.config';
import { OutboxStore, type Claim } from './outbox-store';
import { decideRetry, eventExpiresAt } from './retry-policy';

const SUMMARY_INTERVAL_MS = 60_000;
const MAX_ERROR_BACKOFF_MS = 30_000;

export interface OutboxCounters {
  claimed: number;
  accepted: number;
  retried: number;
  ambiguous: number;
  deadLettered: number;
  noHandler: number;
  lostClaims: number;
  released: number;
}

const zeroCounters = (): OutboxCounters => ({
  claimed: 0,
  accepted: 0,
  retried: 0,
  ambiguous: 0,
  deadLettered: 0,
  noHandler: 0,
  lostClaims: 0,
  released: 0,
});

// R1 / S4b — the reliable outbox consumer.
//
// Notification delivery is a leased, retried, dead-lettered job:
//   PENDING   = unfinished or awaiting a retry
//   PROCESSED = handled — for email, ACCEPTED by the provider (recorded on the
//               delivery first); not necessarily delivered to the inbox
//   FAILED    = permanent failure, retries exhausted, or too stale to send
// An event is claimed with a PostgreSQL lease (see OutboxStore) and is never
// marked PROCESSED until the provider has accepted the message. If this process
// dies at any point the lease expires and the event is picked up again; the
// delivery's recorded intent decides whether that is a clean retry or an
// ambiguous one (see NotificationDispatchService).
//
// The shop queue does NOT depend on any of this: it reads committed Order state
// only (AdminOrdersService, apps/api). A stopped, slow, failing or dead-lettering
// worker can never hide an order.
//
// Concurrency: `concurrency` independent loops, each handling ONE event at a
// time, started once — a loop only asks for more work after finishing the last,
// so polls can never overlap or pile up.
@Injectable()
export class OutboxProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxProcessorService.name);
  private stopping = false;
  private loops: Promise<void>[] = [];
  private sleepers = new Set<() => void>();
  private summaryTimer?: NodeJS.Timeout;
  private counters: OutboxCounters = zeroCounters();
  private lastErrorLogAt = 0;

  constructor(
    private readonly store: OutboxStore,
    private readonly notifications: NotificationDispatchService,
    private readonly tenantContexts: WorkerTenantContextFactory,
    @Inject(OUTBOX_CONFIG) private readonly config: OutboxConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    // Fail closed: without the S4a schema the worker must not run at all.
    await this.store.assertSchemaReady();
    if (!this.config.enabled) {
      this.logger.warn(
        'Notification worker is DISABLED (OUTBOX_WORKER_ENABLED=0): no events will be claimed.',
      );
      return;
    }
    this.logger.log(
      `Notification worker starting: ${this.config.concurrency} loop(s), lease ${this.config.leaseSeconds}s, max ${this.config.maxAttempts} attempts, historical cut-off ${this.config.historicalCutoff?.toISOString() ?? 'none'}.`,
    );
    for (let i = 0; i < this.config.concurrency; i += 1) {
      this.loops.push(this.runLoop());
    }
    this.summaryTimer = setInterval(() => {
      void this.logSummary();
    }, SUMMARY_INTERVAL_MS);
    this.summaryTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  // Graceful shutdown: stop claiming, let attempts already running finish (a
  // send is bounded by its timeout), hand back claims that have not started a
  // send. If something outlives the grace period the process may be killed; the
  // lease then expires and the event is recovered.
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    for (const wake of [...this.sleepers]) wake();
    if (this.loops.length === 0) return;
    let graceTimer: NodeJS.Timeout | undefined;
    const grace = new Promise<'grace'>((resolve) => {
      graceTimer = setTimeout(
        () => resolve('grace'),
        this.config.shutdownGraceMs,
      );
    });
    const outcome = await Promise.race([
      Promise.allSettled(this.loops).then(() => 'done' as const),
      grace,
    ]);
    if (graceTimer) clearTimeout(graceTimer);
    if (outcome === 'grace') {
      this.logger.warn(
        'Shutdown grace period elapsed with attempts still running; their leases will expire and the events will be recovered.',
      );
    }
    this.loops = [];
  }

  getCounters(): Readonly<OutboxCounters> {
    return { ...this.counters };
  }

  // Claims and handles up to `max` due events one after another, then returns how
  // many it handled. The loops use processNext(); this is kept for tests and for
  // a manual "process now" trigger.
  async processPendingBatch(max = 20): Promise<number> {
    let handled = 0;
    while (handled < max && (await this.processNext())) handled += 1;
    return handled;
  }

  // Claims and handles one event. false = nothing was due.
  async processNext(): Promise<boolean> {
    const claim = await this.store.claimNext();
    if (!claim) return false;
    this.counters.claimed += 1;
    await this.handleClaim(claim);
    return true;
  }

  // ---- loops ------------------------------------------------------------

  private async runLoop(): Promise<void> {
    let consecutiveErrors = 0;
    while (!this.stopping) {
      let didWork = false;
      try {
        didWork = await this.processNext();
        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors += 1;
        this.logThrottled('Outbox processing failed', error);
      }
      if (this.stopping) break;
      if (!didWork) {
        const backoff =
          consecutiveErrors === 0
            ? this.config.pollIntervalMs
            : Math.min(
                MAX_ERROR_BACKOFF_MS,
                this.config.pollIntervalMs *
                  2 ** Math.min(consecutiveErrors, 8),
              );
        // Jitter so several loops/workers do not poll in lockstep.
        await this.sleep(backoff * (0.8 + 0.4 * Math.random()));
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.sleepers.add(done);
    });
  }

  private logThrottled(message: string, error: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt < 10_000) return;
    this.lastErrorLogAt = now;
    this.logger.error(message, error);
  }

  private async logSummary(): Promise<void> {
    const c = this.counters;
    this.counters = zeroCounters();
    try {
      const s = await this.store.snapshot();
      const active =
        c.claimed > 0 ||
        s.heldByCutoff > 0 ||
        s.heldBySuspension > 0 ||
        s.dueNow > 0 ||
        s.retrying > 0 ||
        s.deadLetteredLast24h > 0;
      if (!active) return;
      const line =
        `Outbox (last minute): claimed=${c.claimed} accepted=${c.accepted} retried=${c.retried} ` +
        `ambiguous=${c.ambiguous} dead=${c.deadLettered} lostClaims=${c.lostClaims}; ` +
        `backlog: due=${s.dueNow} retrying=${s.retrying} leased=${s.leased} heldByCutoff=${s.heldByCutoff} heldBySuspension=${s.heldBySuspension} ` +
        `oldestDueSeconds=${s.oldestDueAgeSeconds === null ? 'n/a' : Math.round(s.oldestDueAgeSeconds)} ` +
        `deadLettered=${s.deadLettered} (24h: ${s.deadLetteredLast24h})`;
      if (s.deadLetteredLast24h > 0 || c.deadLettered > 0) {
        this.logger.warn(line);
      } else {
        this.logger.log(line);
      }
    } catch (error) {
      this.logThrottled('Could not read the outbox snapshot', error);
    }
  }

  // ---- one claimed event ------------------------------------------------

  private async handleClaim(claim: Claim): Promise<void> {
    const event: ClaimedOutboxEvent = {
      id: claim.eventId,
      aggregateType: claim.aggregateType,
      aggregateId: claim.aggregateId,
      eventType: claim.eventType,
      tenantId: claim.tenantId,
    };
    try {
      // Milestone S0C / S0D-2C-2 — the claimed event's work runs inside an
      // explicit worker TenantContext built from the event's OWN persisted
      // tenantId (never SINGLE_TENANT_ID, never the JSON payload). Fails closed.
      let tenantContext: ReturnType<
        WorkerTenantContextFactory['forOutboxEvent']
      >;
      try {
        tenantContext = this.tenantContexts.forOutboxEvent(event);
      } catch (error) {
        await this.finishDead(
          claim,
          event,
          'TENANT_CONTEXT_INVALID',
          this.message(error),
        );
        return;
      }
      await runWithTenantContext(tenantContext, () =>
        this.attempt(claim, event),
      );
    } catch (error) {
      // Backstop: an unexpected bug must neither lose the event nor wedge the
      // loop. Treat it as a retryable failure.
      // Message only (no stack, no cause chain): driver errors can quote values.
      this.logger.error(
        `Unexpected failure handling outbox event ${claim.eventId} (${claim.eventType}): ${redactEmails(this.message(error))}`,
      );
      try {
        await this.finishRetryOrDead(
          claim,
          event,
          'UNEXPECTED_ERROR',
          this.message(error),
          false,
        );
      } catch {
        // The database itself is unreachable: the lease will expire and the
        // event will be recovered.
      }
    }
  }

  private async attempt(
    claim: Claim,
    event: ClaimedOutboxEvent,
  ): Promise<void> {
    // A claim whose attempts keep ending without ANY outcome (the process dies
    // each time) would otherwise be reclaimed forever. The generation counts
    // claims, so it is the bound.
    if (claim.generation > this.config.maxAttempts) {
      await this.finishDead(
        claim,
        event,
        'ATTEMPTS_EXCEEDED',
        `Claimed ${claim.generation} times without reaching an outcome (limit ${this.config.maxAttempts}); the worker may be crashing on this event.`,
      );
      return;
    }

    // The provider already accepted this message on an earlier attempt: that
    // wins over every other consideration (expiry, retries).
    if (await this.notifications.hasAcceptedDelivery(event)) {
      if (await this.store.complete(claim)) this.counters.accepted += 1;
      else this.noteLostClaim(claim, 'while completing an accepted delivery');
      return;
    }

    // Too stale to be worth sending? (Event-specific; see retry-policy.) Uses
    // the DATABASE clock as of the claim, never this host's.
    const expiresAt = eventExpiresAt(
      claim.eventType,
      claim.createdAt,
      claim.expiresAt,
    );
    if (expiresAt && claim.dbNow.getTime() >= expiresAt.getTime()) {
      await this.finishDead(
        claim,
        event,
        'EVENT_EXPIRED',
        `The notification was not sent because it went stale at ${expiresAt.toISOString()}.`,
      );
      return;
    }

    // Shutting down before anything was sent: hand the claim back untouched.
    if (this.stopping) {
      if (await this.store.release(claim)) this.counters.released += 1;
      return;
    }

    // SC0.5a — the business was suspended after this event was claimed: hand
    // the claim back without using up an attempt (claimNext will not take it
    // again until the business is ACTIVE). Only a send already past this point
    // can still complete.
    if (!(await this.store.isTenantActive(claim.tenantId))) {
      if (await this.store.release(claim)) this.counters.released += 1;
      return;
    }

    const outcome = await this.notifications.dispatch(event, {
      beginSend: (deliveryId, flag) =>
        this.store.beginSend(claim, deliveryId, flag),
    });
    await this.apply(claim, event, outcome);
  }

  private async apply(
    claim: Claim,
    event: ClaimedOutboxEvent,
    outcome: DispatchOutcome,
  ): Promise<void> {
    switch (outcome.kind) {
      case 'no-handler':
        if (await this.store.complete(claim)) this.counters.noHandler += 1;
        else this.counters.lostClaims += 1;
        return;
      // R1 / S5b — deliberately not sent (a READY notice for an order that was
      // rejected or cancelled): the event is complete, nothing was sent, and
      // it is not a failure, so it never alerts.
      case 'suppressed':
        if (await this.store.complete(claim)) this.counters.noHandler += 1;
        else this.counters.lostClaims += 1;
        this.logger.log(
          `Outbox event ${claim.eventId} (${claim.eventType}) not sent: ${outcome.code}.`,
        );
        return;
      case 'accepted':
        if (await this.store.complete(claim)) this.counters.accepted += 1;
        else
          this.noteLostClaim(claim, 'after the provider accepted the message');
        return;
      case 'lost-claim':
        this.noteLostClaim(claim, 'before sending');
        return;
      case 'dead':
        await this.finishDead(
          claim,
          event,
          outcome.code,
          outcome.reason,
          !outcome.deliveryMarked,
        );
        return;
      case 'retry':
        await this.finishRetryOrDead(
          claim,
          event,
          outcome.code,
          outcome.reason,
          outcome.ambiguous,
        );
        return;
    }
  }

  private async finishRetryOrDead(
    claim: Claim,
    event: ClaimedOutboxEvent,
    code: string,
    reason: string,
    ambiguous: boolean,
  ): Promise<void> {
    const expiresAt = eventExpiresAt(
      claim.eventType,
      claim.createdAt,
      claim.expiresAt,
    );
    // If the provider already accepted the message, the event is done.
    if (await this.notifications.hasAcceptedDelivery(event)) {
      if (await this.store.complete(claim)) this.counters.accepted += 1;
      return;
    }
    const decision = decideRetry({
      attempt: claim.generation,
      now: claim.dbNow,
      expiresAt,
      config: this.config,
    });
    if (decision.action === 'dead') {
      await this.finishDead(
        claim,
        event,
        decision.code ?? 'RETRIES_EXHAUSTED',
        `${code}: ${reason}`,
      );
      return;
    }
    if (
      await this.store.reschedule(claim, decision.delayMs ?? 0, code, reason)
    ) {
      this.counters.retried += 1;
      if (ambiguous) this.counters.ambiguous += 1;
      this.logger.warn(
        `Outbox event ${claim.eventId} (${claim.eventType}) attempt ${claim.generation} ${ambiguous ? 'ended without an answer' : 'failed'} (${code}); retrying in ${Math.round((decision.delayMs ?? 0) / 1000)}s.`,
      );
    } else {
      this.noteLostClaim(claim, 'while scheduling a retry');
    }
  }

  // Dead-letters the event (FAILED) and makes sure the delivery shows it.
  // `markDelivery` = false when the dispatch already did.
  private async finishDead(
    claim: Claim,
    event: ClaimedOutboxEvent,
    code: string,
    reason: string,
    markDelivery = true,
  ): Promise<void> {
    // Dead-letter the event under the claim FIRST; only the owner of the claim
    // may then mark the delivery failed.
    if (await this.store.deadLetter(claim, code, `${code}: ${reason}`)) {
      if (markDelivery) {
        await this.notifications.failDelivery(event, null, code, reason);
      }
      this.counters.deadLettered += 1;
      this.logger.error(
        `Outbox event ${claim.eventId} (${claim.eventType}, tenant ${claim.tenantId}) dead-lettered after ${claim.generation} attempt(s): ${code}.`,
      );
    } else {
      this.noteLostClaim(claim, 'while dead-lettering');
    }
  }

  private noteLostClaim(claim: Claim, when: string): void {
    this.counters.lostClaims += 1;
    this.logger.warn(
      `Outbox event ${claim.eventId} is no longer owned by this attempt (${when}); another attempt will finish it.`,
    );
  }

  private message(error: unknown): string {
    return redactEmails(
      error instanceof Error ? error.message : 'Unknown error',
    ).slice(0, 500);
  }
}
