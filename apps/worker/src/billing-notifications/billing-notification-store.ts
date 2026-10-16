import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { toErrorCode } from '../outbox/outbox-store';

// SC3c-3 — the ONLY place that touches the billing notification lease and
// retry columns (raw SQL: the claim needs FOR UPDATE SKIP LOCKED and the
// database clock). BillingNotification is PLATFORM data (no tenant column);
// the business is reached only through the row's subscription.
//
// Time: timezone('utc', now()) — the columns are timestamp WITHOUT time zone
// holding UTC — so no host clock decides a lease or a retry.
//
// Fencing: a claim is (id, leaseOwner, attemptCount). Every claim takes a
// fresh owner token and bumps attemptCount, so a stale worker whose lease
// expired (and whose row was re-claimed) matches nothing and changes nothing.
//
// At most MAX_ATTEMPTS sends: a row is claimable only below it. A row whose
// last attempt never finished (the process died) is closed as FAILED by
// closeAbandoned once its lease has expired.

export const MAX_ATTEMPTS = 2;

export interface BillingClaim {
  readonly id: string;
  readonly subscriptionId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly attempt: number;
  readonly expiresAt: Date;
  // A previous attempt had started sending (its outcome is unknown).
  readonly previouslyStarted: boolean;
  readonly owner: string;
  readonly dbNow: Date;
}

interface ClaimRow {
  id: string;
  subscriptionId: string;
  kind: string;
  payload: unknown;
  attemptCount: number;
  expiresAt: Date;
  sendStartedAt: Date | null;
  dbNow: Date;
}

@Injectable()
export class BillingNotificationStore {
  constructor(private readonly prisma: PrismaService) {}

  async claim(leaseMs: number): Promise<BillingClaim | null> {
    const owner = randomUUID();
    const rows = await this.prisma.$queryRaw<ClaimRow[]>`
      UPDATE "BillingNotification" AS n
         SET "leaseOwner" = ${owner},
             "leaseExpiresAt" = timezone('utc', now()) + (${leaseMs}::int * interval '1 millisecond'),
             "attemptCount" = n."attemptCount" + 1
       WHERE n."id" = (
               SELECT c."id" FROM "BillingNotification" AS c
                WHERE c."status" = 'PENDING'
                  AND c."attemptCount" < ${MAX_ATTEMPTS}
                  AND c."nextAttemptAt" <= timezone('utc', now())
                  AND (c."leaseExpiresAt" IS NULL OR c."leaseExpiresAt" < timezone('utc', now()))
                ORDER BY c."nextAttemptAt" ASC, c."id" ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
             )
      RETURNING n."id", n."subscriptionId", n."kind", n."payload", n."attemptCount",
                n."expiresAt", n."sendStartedAt", timezone('utc', now()) AS "dbNow"`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      subscriptionId: row.subscriptionId,
      kind: row.kind,
      payload: row.payload,
      attempt: row.attemptCount,
      expiresAt: row.expiresAt,
      previouslyStarted: row.sendStartedAt !== null,
      owner,
      dbNow: row.dbNow,
    };
  }

  // Recorded BEFORE the provider call: if this process dies mid-send, the
  // next attempt knows the outcome is unknown (possible duplicate).
  // Only while this claim's lease is still live, and it is renewed for the
  // send (`leaseMs` must outlast the send timeout): a claim whose lease
  // lapsed (another worker may have taken it) never sends.
  async markSendStarted(
    claim: BillingClaim,
    leaseMs: number,
  ): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE "BillingNotification"
         SET "sendStartedAt" = timezone('utc', now()),
             "possibleDuplicate" = "possibleDuplicate" OR "sendStartedAt" IS NOT NULL,
             "leaseExpiresAt" = timezone('utc', now()) + (${leaseMs}::int * interval '1 millisecond')
       WHERE "id" = ${claim.id} AND "status" = 'PENDING'
         AND "leaseOwner" = ${claim.owner} AND "attemptCount" = ${claim.attempt}
         AND "leaseExpiresAt" > timezone('utc', now())`;
    return count === 1;
  }

  async finish(
    claim: BillingClaim,
    status: 'SENT' | 'SKIPPED' | 'FAILED',
    code: string | null,
  ): Promise<boolean> {
    const errorCode = code === null ? null : toErrorCode(code);
    const count = await this.prisma.$executeRaw`
      UPDATE "BillingNotification"
         SET "status" = ${status},
             "finishedAt" = timezone('utc', now()),
             "sentAt" = CASE WHEN ${status} = 'SENT' THEN timezone('utc', now()) ELSE NULL END,
             "lastErrorCode" = ${errorCode},
             "leaseOwner" = NULL,
             "leaseExpiresAt" = NULL
       WHERE "id" = ${claim.id} AND "status" = 'PENDING'
         AND "leaseOwner" = ${claim.owner} AND "attemptCount" = ${claim.attempt}`;
    return count === 1;
  }

  async retryLater(
    claim: BillingClaim,
    code: string,
    delayMs: number,
  ): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE "BillingNotification"
         SET "nextAttemptAt" = timezone('utc', now()) + (${delayMs}::int * interval '1 millisecond'),
             "lastErrorCode" = ${toErrorCode(code)},
             "leaseOwner" = NULL,
             "leaseExpiresAt" = NULL
       WHERE "id" = ${claim.id} AND "status" = 'PENDING'
         AND "leaseOwner" = ${claim.owner} AND "attemptCount" = ${claim.attempt}`;
    return count === 1;
  }

  // Rows whose attempts are used up but whose last attempt never finished
  // (lease expired): closed as FAILED — a possible duplicate when a send had
  // started. Returns them so each gets a review case.
  async closeAbandoned(
    limit: number,
  ): Promise<{ id: string; subscriptionId: string }[]> {
    return this.prisma.$queryRaw<{ id: string; subscriptionId: string }[]>`
      UPDATE "BillingNotification" AS n
         SET "status" = 'FAILED',
             "finishedAt" = timezone('utc', now()),
             "lastErrorCode" = 'ATTEMPT_ABANDONED',
             "possibleDuplicate" = n."sendStartedAt" IS NOT NULL,
             "leaseOwner" = NULL,
             "leaseExpiresAt" = NULL
       WHERE n."id" IN (
               SELECT c."id" FROM "BillingNotification" AS c
                WHERE c."status" = 'PENDING'
                  AND c."attemptCount" >= ${MAX_ATTEMPTS}
                  AND (c."leaseExpiresAt" IS NULL OR c."leaseExpiresAt" < timezone('utc', now()))
                ORDER BY c."id"
                LIMIT ${limit}
                FOR UPDATE SKIP LOCKED
             )
      RETURNING n."id", n."subscriptionId"`;
  }
}
