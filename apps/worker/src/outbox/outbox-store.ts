import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OUTBOX_CONFIG, type OutboxConfig } from './outbox.config';
import { orderClosedForReadyNotice } from '../notifications/order-closed-guard';

// R1 / S4b — the ONLY place that touches the outbox lease and retry columns.
//
// Why raw SQL: the claim needs `FOR UPDATE SKIP LOCKED` and the database clock,
// which Prisma's query API cannot express. Raw statements bypass the tenant
// query audit (which only observes Prisma model operations), so they are all
// here, named, reviewed and covered by tests rather than scattered. Two rules
// make them tenant-safe:
//   - the claim is deliberately cross-tenant (it must pick the next due event of
//     ANY business) and returns that event's own tenantId; every later step runs
//     in a TenantContext built from it (see OutboxProcessorService);
//   - every write after the claim names the event's tenantId in its WHERE.
//
// Time: all instants are timezone('utc', now()) — the columns are timestamp
// WITHOUT time zone holding UTC — never a bare now() and never a JS clock, so
// worker clock skew cannot affect leases or backoff.
//
// Fencing: a claim is identified by (id, tenantId, leaseOwner, attemptCount).
// leaseOwner is a fresh random token per claim and attemptCount is bumped by
// every claim, so a stale worker (whose lease expired and whose event was
// re-claimed, even by itself) cannot match the row and its writes change
// nothing.

export interface Claim {
  readonly eventId: string;
  readonly tenantId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  // Fencing identity of this claim.
  readonly owner: string;
  readonly generation: number;
  // The database clock when the claim was taken (UTC), used for staleness so no
  // decision depends on this host's clock.
  readonly dbNow: Date;
}

export interface OutboxSnapshot {
  readonly dueNow: number;
  readonly retrying: number;
  readonly leased: number;
  readonly oldestDueAgeSeconds: number | null;
  readonly deadLettered: number;
  readonly deadLetteredLast24h: number;
  // PENDING events held back by OUTBOX_HISTORICAL_CUTOFF (waiting for an
  // operator to classify them); never counted as "due".
  readonly heldByCutoff: number;
  // SC0.5a — PENDING events of a business that is not ACTIVE: kept intact and
  // not claimed until it is reactivated; never counted as "due".
  readonly heldBySuspension: number;
}

interface ClaimRow {
  id: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  createdAt: Date;
  expiresAt: Date | null;
  attemptCount: number;
  dbNow: Date;
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  OutboxEvent: [
    'attemptCount',
    'nextAttemptAt',
    'lastAttemptAt',
    'leaseOwner',
    'leaseExpiresAt',
    'expiresAt',
    'lastErrorCode',
    'lastError',
    'failedAt',
  ],
  NotificationDelivery: ['sendStartedAt', 'possibleDuplicate'],
};

// OutboxEvent.lastErrorCode is constrained to UPPER_SNAKE (S4a CHECK), but
// provider error names arrive as CamelCase ("MessageRejected"). Normalised here,
// at the one boundary that writes it, so no caller can violate the constraint.
export function toErrorCode(raw: string): string {
  const snake = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  const code = /^[A-Z]/.test(snake)
    ? snake
    : snake
      ? `E_${snake}`
      : 'UNKNOWN_ERROR';
  return code.slice(0, 64);
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

class IntentNotRecorded extends Error {}

@Injectable()
export class OutboxStore {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OUTBOX_CONFIG) private readonly config: OutboxConfig,
  ) {}

  // Fails closed when the S4a migration has not been applied: a worker that
  // cannot lease must not run at all (and must never fall back to the legacy
  // claim-then-send behaviour).
  async assertSchemaReady(): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      Array<{ table_name: string; column_name: string }>
    >`SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('OutboxEvent', 'NotificationDelivery')`;
    const present = new Set(
      rows.map((r) => `${r.table_name}.${r.column_name}`),
    );
    const missing: string[] = [];
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      for (const column of columns) {
        if (!present.has(`${table}.${column}`))
          missing.push(`${table}.${column}`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `The notification worker requires the S4a migrations (20261018090000 and 20261018090100). Missing columns: ${missing.join(', ')}. Refusing to start.`,
      );
    }
  }

  // Atomically takes the next due, unleased event, or null. Safe for any number
  // of concurrent workers: SKIP LOCKED hands each a different row, and the lease
  // is written in the same statement that selects the row.
  //
  // SC0.5a — only events of an ACTIVE business are ever claimed. A SUSPENDED
  // business's events are simply not taken: they stay PENDING with their
  // attemptCount, nextAttemptAt and last error untouched (no attempt consumed,
  // no lease, no dead letter, no retry loop), and become due again the moment
  // the business is reactivated. They still go through the normal staleness
  // rules then (retry-policy), so a notice that went stale while held is
  // dead-lettered as EVENT_EXPIRED, never sent late and never silently dropped.
  async claimNext(): Promise<Claim | null> {
    const owner = `${this.config.workerId}:${randomUUID()}`;
    const cutoff = this.config.historicalCutoff;
    const rows = await this.prisma.$queryRaw<ClaimRow[]>`
      UPDATE "OutboxEvent" AS e
         SET "leaseOwner" = ${owner},
             "leaseExpiresAt" = timezone('utc', now()) + (${this.config.leaseSeconds}::double precision * interval '1 second'),
             "attemptCount" = e."attemptCount" + 1,
             "lastAttemptAt" = timezone('utc', now())
       WHERE e.id = (
         SELECT id FROM "OutboxEvent"
          WHERE status = 'PENDING'
            AND "nextAttemptAt" <= timezone('utc', now())
            AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < timezone('utc', now()))
            AND (${cutoff}::timestamptz IS NULL OR "createdAt" >= (${cutoff}::timestamptz AT TIME ZONE 'utc'))
            AND EXISTS (SELECT 1 FROM "Tenant" t
                         WHERE t.id = "OutboxEvent"."tenantId" AND t.status = 'ACTIVE')
          ORDER BY "nextAttemptAt", "createdAt"
          LIMIT 1
          FOR UPDATE SKIP LOCKED)
      RETURNING e.id, e."tenantId", e."aggregateType", e."aggregateId", e."eventType",
                e."createdAt", e."expiresAt", e."attemptCount",
                timezone('utc', now()) AS "dbNow"`;
    const row = rows[0];
    if (!row) return null;
    return {
      eventId: row.id,
      tenantId: row.tenantId,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      owner,
      generation: Number(row.attemptCount),
      dbNow: row.dbNow,
    };
  }

  // SC0.5a — re-checked just before a claimed event is sent (see
  // OutboxProcessorService.attempt). A missing business is not ACTIVE.
  async isTenantActive(tenantId: string): Promise<boolean> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    return tenant?.status === 'ACTIVE';
  }

  // Delivery intent. In ONE transaction: confirm this claim is still current and
  // has enough lease left to finish a send, then durably record that a send is
  // starting. Returns false (and writes nothing) when the claim was lost.
  //
  // R1 / S5b — for a READY notice it also re-reads the order under a row lock
  // and answers 'order-closed' (recording no intent) when the order has been
  // rejected or cancelled since it was resolved (see orderClosedForReadyNotice).
  async beginSend(
    claim: Claim,
    deliveryId: string,
    flagPossibleDuplicate: boolean,
  ): Promise<boolean | 'order-closed'> {
    return this.prisma
      .$transaction(async (tx) => {
        const held = await tx.$executeRaw`
        UPDATE "OutboxEvent"
           SET "lastAttemptAt" = timezone('utc', now())
         WHERE id = ${claim.eventId} AND "tenantId" = ${claim.tenantId}
           AND "leaseOwner" = ${claim.owner} AND "attemptCount" = ${claim.generation}
           AND status = 'PENDING'
           AND "leaseExpiresAt" > timezone('utc', now()) + (${this.config.minLeaseRemainingMs}::double precision * interval '1 millisecond')`;
        if (held !== 1) return false;
        if (await orderClosedForReadyNotice(tx, claim)) return 'order-closed';
        const recorded = await tx.$executeRaw`
        UPDATE "NotificationDelivery"
           SET "sendStartedAt" = timezone('utc', now()),
               "failureReason" = NULL,
               "possibleDuplicate" = ("possibleDuplicate" OR ${flagPossibleDuplicate})
         WHERE id = ${deliveryId} AND "tenantId" = ${claim.tenantId} AND status = 'PENDING'`;
        // No durable intent, no send: roll the claim check back too.
        if (recorded !== 1) throw new IntentNotRecorded();
        return true;
      })
      .catch((error: unknown) => {
        if (error instanceof IntentNotRecorded) return false;
        throw error;
      });
  }

  // Terminal success: the provider accepted the message (recorded on the
  // delivery BEFORE this is called). Fenced.
  async complete(claim: Claim): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE "OutboxEvent"
         SET status = 'PROCESSED', "processedAt" = timezone('utc', now()),
             "leaseOwner" = NULL, "leaseExpiresAt" = NULL
       WHERE id = ${claim.eventId} AND "tenantId" = ${claim.tenantId}
         AND "leaseOwner" = ${claim.owner} AND "attemptCount" = ${claim.generation}
         AND status = 'PENDING'`;
    return n === 1;
  }

  // Schedule another attempt. Fenced.
  async reschedule(
    claim: Claim,
    delayMs: number,
    code: string,
    message: string,
  ): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE "OutboxEvent"
         SET "nextAttemptAt" = timezone('utc', now()) + (${delayMs}::double precision * interval '1 millisecond'),
             "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
             "lastErrorCode" = ${toErrorCode(code)}, "lastError" = ${truncate(message, 2000)}
       WHERE id = ${claim.eventId} AND "tenantId" = ${claim.tenantId}
         AND "leaseOwner" = ${claim.owner} AND "attemptCount" = ${claim.generation}
         AND status = 'PENDING'`;
    return n === 1;
  }

  // Terminal failure (the dead letter). Fenced.
  async deadLetter(
    claim: Claim,
    code: string,
    message: string,
  ): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE "OutboxEvent"
         SET status = 'FAILED', "failedAt" = timezone('utc', now()),
             "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
             "lastErrorCode" = ${toErrorCode(code)}, "lastError" = ${truncate(message, 2000)}
       WHERE id = ${claim.eventId} AND "tenantId" = ${claim.tenantId}
         AND "leaseOwner" = ${claim.owner} AND "attemptCount" = ${claim.generation}
         AND status = 'PENDING'`;
    return n === 1;
  }

  // Hands a claim back WITHOUT consuming an attempt (graceful shutdown before a
  // send began). The unique owner token makes reusing the generation safe.
  async release(claim: Claim): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE "OutboxEvent"
         SET "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
             "attemptCount" = GREATEST(0, "attemptCount" - 1)
       WHERE id = ${claim.eventId} AND "tenantId" = ${claim.tenantId}
         AND "leaseOwner" = ${claim.owner} AND "attemptCount" = ${claim.generation}
         AND status = 'PENDING'`;
    return n === 1;
  }

  // Aggregate counts for logs and the runbook. No identifiers, no content.
  async snapshot(): Promise<OutboxSnapshot> {
    const cutoff = this.config.historicalCutoff;
    const rows = await this.prisma.$queryRaw<
      Array<{
        due_now: bigint;
        retrying: bigint;
        leased: bigint;
        oldest_due_age: number | null;
        dead: bigint;
        dead_24h: bigint;
        held: bigint;
        held_suspended: bigint;
      }>
    >`SELECT
        count(*) FILTER (WHERE e.status = 'PENDING' AND e."nextAttemptAt" <= timezone('utc', now())
                          AND (${cutoff}::timestamptz IS NULL OR e."createdAt" >= (${cutoff}::timestamptz AT TIME ZONE 'utc'))
                          AND (e."leaseExpiresAt" IS NULL OR e."leaseExpiresAt" < timezone('utc', now()))
                          AND t.status = 'ACTIVE') AS due_now,
        count(*) FILTER (WHERE e.status = 'PENDING' AND ${cutoff}::timestamptz IS NOT NULL
                          AND e."createdAt" < (${cutoff}::timestamptz AT TIME ZONE 'utc')) AS held,
        count(*) FILTER (WHERE e.status = 'PENDING' AND t.status IS DISTINCT FROM 'ACTIVE') AS held_suspended,
        count(*) FILTER (WHERE e.status = 'PENDING' AND e."attemptCount" > 0) AS retrying,
        count(*) FILTER (WHERE e.status = 'PENDING' AND e."leaseExpiresAt" >= timezone('utc', now())) AS leased,
        extract(epoch FROM (timezone('utc', now()) - min(e."nextAttemptAt") FILTER (WHERE e.status = 'PENDING'
                          AND e."nextAttemptAt" <= timezone('utc', now())
                          AND (${cutoff}::timestamptz IS NULL OR e."createdAt" >= (${cutoff}::timestamptz AT TIME ZONE 'utc'))
                          AND t.status = 'ACTIVE'))) AS oldest_due_age,
        count(*) FILTER (WHERE e.status = 'FAILED') AS dead,
        count(*) FILTER (WHERE e.status = 'FAILED' AND e."failedAt" > timezone('utc', now()) - interval '24 hours') AS dead_24h
       FROM "OutboxEvent" AS e
       LEFT JOIN "Tenant" AS t ON t.id = e."tenantId"
      WHERE e.status IN ('PENDING', 'FAILED')`;
    const r = rows[0];
    return {
      dueNow: Number(r.due_now),
      retrying: Number(r.retrying),
      leased: Number(r.leased),
      oldestDueAgeSeconds:
        r.oldest_due_age === null ? null : Number(r.oldest_due_age),
      deadLettered: Number(r.dead),
      deadLetteredLast24h: Number(r.dead_24h),
      heldByCutoff: Number(r.held),
      heldBySuspension: Number(r.held_suspended),
    };
  }
}
