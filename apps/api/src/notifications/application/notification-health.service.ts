import { Injectable } from '@nestjs/common';
import type {
  NotificationHealthItem,
  NotificationHealthReasonCount,
  NotificationHealthResponse,
} from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import {
  CRITICAL_DELAY_SECONDS,
  DELAYED_AFTER_SECONDS,
  REPEATED_FAILURE_ATTEMPTS,
  buildAttention,
  overallStatus,
} from './notification-health-attention';

const MAX_ITEMS = 25;
// Deliberate operator closure at a cut-over (see the cut-over runbook): not a
// delivery failure, so it never counts toward, or alerts as, one.
const CLOSED_DELIBERATELY = 'HISTORICAL_NOT_SENT';
const MAX_REASONS = 8;

interface SummaryRow {
  now: Date;
  pending_total: bigint;
  waiting: bigint;
  in_progress: bigint;
  scheduled_retry: bigint;
  delayed: bigint;
  repeated: bigint;
  oldest_pending: number | null;
  oldest_retrying: number | null;
  oldest_overdue: number | null;
  failed_total: bigint;
  failed_24h: bigint;
  failed_7d: bigint;
  closed: bigint;
}

interface ReasonRow {
  code: string | null;
  n: bigint;
}

interface ItemRow {
  id: string;
  eventType: string;
  state: 'dead-lettered' | 'delayed' | 'retrying';
  attempts: number;
  reasonCode: string | null;
  createdAt: Date;
  nextAttemptAt: Date | null;
  failedAt: Date | null;
  reference: string | null;
  possibleDuplicate: boolean | null;
}

// R1 / S4c — a read-only summary of this business's notification pipeline.
//
// Tenant isolation: every statement below names `tenantId = ${tenant.tenantId}`
// (the caller's own, from the server-resolved TenantContext, never client
// input), including the joins to Order and NotificationDelivery. The statements
// are raw SQL because the figures need the database clock and FILTER
// aggregates; raw statements bypass the tenant query audit, which is why they
// are all here, named, and covered by two-tenant tests.
//
// Independent of the shop queue: this reads the outbox and delivery tables
// only, never writes, and nothing in the order workflow reads it. A failing or
// slow summary cannot affect an order.
//
// No sensitive data: the selected columns exclude recipient addresses, message
// content, tokens and the free-text error (only the machine-readable reason
// code is returned), and nothing is logged.
@Injectable()
export class NotificationHealthService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<NotificationHealthResponse> {
    authorization.assertCorporate('notifications.routing.view');
    const tenantId = tenant.tenantId;
    const delayed = DELAYED_AFTER_SECONDS;
    const repeated = REPEATED_FAILURE_ATTEMPTS;

    // Every PENDING row falls into exactly one bucket (priority order):
    //   in progress -> scheduled retry -> delayed -> waiting.
    const [row] = await this.prisma.$queryRaw<SummaryRow[]>`
      SELECT
        timezone('utc', now()) AS "now",
        count(*) FILTER (WHERE status = 'PENDING') AS pending_total,
        count(*) FILTER (WHERE status = 'PENDING'
                          AND "leaseExpiresAt" >= timezone('utc', now())) AS in_progress,
        count(*) FILTER (WHERE status = 'PENDING'
                          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < timezone('utc', now()))
                          AND "nextAttemptAt" > timezone('utc', now())) AS scheduled_retry,
        count(*) FILTER (WHERE status = 'PENDING'
                          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < timezone('utc', now()))
                          AND "nextAttemptAt" <= timezone('utc', now()) - (${delayed}::double precision * interval '1 second')) AS delayed,
        count(*) FILTER (WHERE status = 'PENDING'
                          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < timezone('utc', now()))
                          AND "nextAttemptAt" <= timezone('utc', now())
                          AND "nextAttemptAt" > timezone('utc', now()) - (${delayed}::double precision * interval '1 second')) AS waiting,
        count(*) FILTER (WHERE status = 'PENDING' AND "attemptCount" >= ${repeated}) AS repeated,
        extract(epoch FROM (timezone('utc', now()) - min("createdAt") FILTER (WHERE status = 'PENDING'))) AS oldest_pending,
        extract(epoch FROM (timezone('utc', now()) - min("createdAt") FILTER (WHERE status = 'PENDING' AND "attemptCount" > 0))) AS oldest_retrying,
        extract(epoch FROM (timezone('utc', now()) - min("nextAttemptAt") FILTER (WHERE status = 'PENDING'
                          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < timezone('utc', now()))
                          AND "nextAttemptAt" <= timezone('utc', now())))) AS oldest_overdue,
        count(*) FILTER (WHERE status = 'FAILED' AND "lastErrorCode" IS DISTINCT FROM ${CLOSED_DELIBERATELY}) AS failed_total,
        count(*) FILTER (WHERE status = 'FAILED' AND "lastErrorCode" IS DISTINCT FROM ${CLOSED_DELIBERATELY}
                          AND "failedAt" > timezone('utc', now()) - interval '24 hours') AS failed_24h,
        count(*) FILTER (WHERE status = 'FAILED' AND "lastErrorCode" IS DISTINCT FROM ${CLOSED_DELIBERATELY}
                          AND "failedAt" > timezone('utc', now()) - interval '7 days') AS failed_7d,
        count(*) FILTER (WHERE status = 'FAILED' AND "lastErrorCode" = ${CLOSED_DELIBERATELY}) AS closed
      FROM "OutboxEvent"
      WHERE "tenantId" = ${tenantId} AND status IN ('PENDING', 'FAILED')`;

    const retryReasons = await this.prisma.$queryRaw<ReasonRow[]>`
      SELECT "lastErrorCode" AS code, count(*) AS n FROM "OutboxEvent"
       WHERE "tenantId" = ${tenantId} AND status = 'PENDING' AND "attemptCount" > 0
       GROUP BY 1 ORDER BY n DESC, 1 LIMIT ${MAX_REASONS}`;
    const failedReasons = await this.prisma.$queryRaw<ReasonRow[]>`
      SELECT "lastErrorCode" AS code, count(*) AS n FROM "OutboxEvent"
       WHERE "tenantId" = ${tenantId} AND status = 'FAILED'
         AND "lastErrorCode" IS DISTINCT FROM ${CLOSED_DELIBERATELY}
         AND "failedAt" > timezone('utc', now()) - interval '7 days'
       GROUP BY 1 ORDER BY n DESC, 1 LIMIT ${MAX_REASONS}`;

    const [deliveries] = await this.prisma.$queryRaw<
      Array<{
        accepted_24h: bigint;
        accepted_7d: bigint;
        duplicates_7d: bigint;
      }>
    >`
      SELECT
        count(*) FILTER (WHERE status = 'SENT' AND "sentAt" > timezone('utc', now()) - interval '24 hours') AS accepted_24h,
        count(*) FILTER (WHERE status = 'SENT' AND "sentAt" > timezone('utc', now()) - interval '7 days') AS accepted_7d,
        count(*) FILTER (WHERE "possibleDuplicate"
                          AND COALESCE("sentAt", "sendStartedAt", "createdAt") > timezone('utc', now()) - interval '7 days') AS duplicates_7d
      FROM "NotificationDelivery"
      WHERE "tenantId" = ${tenantId}
        AND "createdAt" > timezone('utc', now()) - interval '8 days'`;

    // The notifications a person may want to look at, worst first: dead
    // letters from the last 7 days, anything delayed, and anything retrying
    // repeatedly. Order notifications carry the customer-visible order number.
    const items = await this.prisma.$queryRaw<ItemRow[]>`
      SELECT e.id, e."eventType",
             CASE WHEN e.status = 'FAILED' THEN 'dead-lettered'
                  WHEN (e."leaseExpiresAt" IS NULL OR e."leaseExpiresAt" < timezone('utc', now()))
                       AND e."nextAttemptAt" <= timezone('utc', now()) - (${delayed}::double precision * interval '1 second') THEN 'delayed'
                  ELSE 'retrying' END AS state,
             e."attemptCount" AS attempts,
             e."lastErrorCode" AS "reasonCode",
             e."createdAt", e."nextAttemptAt", e."failedAt",
             o."orderNumber" AS reference,
             d."possibleDuplicate"
        FROM "OutboxEvent" e
        LEFT JOIN "Order" o
               ON e."aggregateType" = 'Order' AND o.id = e."aggregateId" AND o."tenantId" = e."tenantId"
        LEFT JOIN "NotificationDelivery" d
               ON d."outboxEventId" = e.id AND d."tenantId" = e."tenantId" AND d.channel = 'EMAIL'
       WHERE e."tenantId" = ${tenantId}
         AND ( (e.status = 'FAILED' AND e."lastErrorCode" IS DISTINCT FROM ${CLOSED_DELIBERATELY}
                    AND e."failedAt" > timezone('utc', now()) - interval '7 days')
            OR (e.status = 'PENDING'
                AND ( e."attemptCount" >= ${repeated}
                   OR ((e."leaseExpiresAt" IS NULL OR e."leaseExpiresAt" < timezone('utc', now()))
                       AND e."nextAttemptAt" <= timezone('utc', now()) - (${delayed}::double precision * interval '1 second')))) )
       ORDER BY CASE WHEN e.status = 'FAILED' THEN 0 ELSE 1 END,
                CASE WHEN e.status = 'FAILED' THEN e."failedAt" END DESC NULLS LAST,
                e."nextAttemptAt" ASC
       LIMIT ${MAX_ITEMS + 1}`;

    const pending = {
      total: Number(row.pending_total),
      waiting: Number(row.waiting),
      inProgress: Number(row.in_progress),
      scheduledRetry: Number(row.scheduled_retry),
      delayed: Number(row.delayed),
      repeatedlyFailing: Number(row.repeated),
      oldestPendingAgeSeconds: seconds(row.oldest_pending),
      oldestRetryingAgeSeconds: seconds(row.oldest_retrying),
      oldestOverdueSeconds: seconds(row.oldest_overdue),
      retryReasons: reasons(retryReasons),
    };
    const failed = {
      total: Number(row.failed_total),
      last24h: Number(row.failed_24h),
      last7d: Number(row.failed_7d),
      reasons: reasons(failedReasons),
      closedDeliberately: Number(row.closed),
    };
    const possibleDuplicatesLast7d = Number(deliveries.duplicates_7d);
    const attention = buildAttention({
      pending,
      failed,
      possibleDuplicatesLast7d,
    });

    return {
      generatedAt: row.now.toISOString(),
      status: overallStatus(attention),
      thresholds: {
        delayedAfterSeconds: DELAYED_AFTER_SECONDS,
        criticalDelaySeconds: CRITICAL_DELAY_SECONDS,
        repeatedFailureAttempts: REPEATED_FAILURE_ATTEMPTS,
      },
      pending,
      failed,
      accepted: {
        last24h: Number(deliveries.accepted_24h),
        last7d: Number(deliveries.accepted_7d),
      },
      possibleDuplicatesLast7d,
      attention,
      items: items.slice(0, MAX_ITEMS).map(toItem),
      itemsTruncated: items.length > MAX_ITEMS,
    };
  }
}

function seconds(value: number | null): number | null {
  return value === null || value === undefined
    ? null
    : Math.max(0, Math.round(Number(value)));
}

function reasons(rows: ReasonRow[]): NotificationHealthReasonCount[] {
  return rows.map((r) => ({ code: r.code ?? 'UNKNOWN', count: Number(r.n) }));
}

function toItem(row: ItemRow): NotificationHealthItem {
  return {
    eventId: row.id,
    eventType: row.eventType,
    state: row.state,
    attempts: Number(row.attempts),
    reasonCode: row.reasonCode,
    createdAt: row.createdAt.toISOString(),
    nextAttemptAt:
      row.state === 'dead-lettered' || !row.nextAttemptAt
        ? null
        : row.nextAttemptAt.toISOString(),
    failedAt: row.failedAt ? row.failedAt.toISOString() : null,
    reference: row.reference,
    possibleDuplicate: row.possibleDuplicate === true,
  };
}
