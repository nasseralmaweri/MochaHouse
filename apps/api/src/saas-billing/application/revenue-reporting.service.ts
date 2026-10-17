import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type {
  PlatformRevenueReport,
  RevenueReportEnvironment,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import type { PlatformOperatorRow } from '../../platform-auth/infrastructure/platform-identity';
import {
  SAAS_BILLING_PROVIDER,
  type SaasBillingProvider,
} from '../provider/saas-billing-provider';
import {
  adjustmentTotals,
  annualMinorUnits,
  buildTimeline,
  invariantViolations,
  monthOf,
  monthWindows,
  mrrOf,
  payingNow,
  recurringOf,
  trialCohorts,
  type AdjustmentInput,
  type InvoiceInput,
  type PriceInfo,
  type SubscriptionInput,
  type Timeline,
} from '../domain/revenue-metrics';

// SC3f — CENTERIVO SaaS revenue reporting (owner decisions D1–D7), READ-ONLY.
// It reads only CENTERIVO subscription billing: subscriptions, their
// append-only history, plan prices, completed checkouts, complimentary
// grants, invoices and refund/credit adjustments — never a restaurant's
// orders, sales, customer payments or gift cards (saas-billing-separation
// and revenue-reporting specs). Nothing about an individual business is
// returned: only totals.
//
// Reads are bounded: a period of at most 24 months, subscriptions and
// invoices in batches, and a hard ceiling beyond which the report refuses
// rather than running unbounded.

const MAX_MONTHS = 24;
const BATCH = 500;
const MAX_SUBSCRIPTIONS = 50_000;
const MAX_INVOICES = 200_000;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

const HISTORY_TYPES = [
  'TRIAL_STARTED',
  'PAYMENT_AUTHORIZED',
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
  'GRACE_EXPIRED',
  'TRIAL_EXPIRED',
  'RECOVERY_EXPIRED',
  'SUBSCRIPTION_REPLACED',
  'CANCELED',
  'PLAN_CHANGE_APPLIED',
  'COMPLIMENTARY_STARTED',
  'COMPLIMENTARY_ENDED',
] as const;

const monthKey = (date: Date) =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

const monthIndex = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return y * 12 + (m - 1);
};

export function parsePeriod(
  query: { from?: unknown; to?: unknown },
  now: Date,
): { from: string; to: string } {
  const current = monthKey(now);
  const read = (value: unknown, name: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !MONTH.test(value)) {
      throw new BadRequestException(`${name} must be a month (YYYY-MM).`);
    }
    return value;
  };
  const to = read(query.to, 'to') ?? current;
  const fromDefault = (() => {
    const i = monthIndex(to) - 11;
    return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
  })();
  const from = read(query.from, 'from') ?? fromDefault;
  if (monthIndex(to) > monthIndex(current)) {
    throw new BadRequestException('The period cannot end in the future.');
  }
  if (monthIndex(from) > monthIndex(to)) {
    throw new BadRequestException('The period must start before it ends.');
  }
  if (monthIndex(to) - monthIndex(from) + 1 > MAX_MONTHS) {
    throw new BadRequestException(`At most ${MAX_MONTHS} months at a time.`);
  }
  return { from, to };
}

function tooMany(what: string): BadRequestException {
  return new BadRequestException(
    `Too many ${what} to report on at once. Choose a shorter period.`,
  );
}

@Injectable()
export class RevenueReportingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SAAS_BILLING_PROVIDER)
    private readonly provider: SaasBillingProvider,
  ) {}

  private environment(): RevenueReportEnvironment {
    if (!this.provider.available) return 'NO_PROVIDER';
    if (this.provider.name !== 'stripe') return 'DEVELOPMENT';
    return this.provider.livemode ? 'STRIPE_LIVE_MODE' : 'STRIPE_TEST_MODE';
  }

  async report(
    query: { from?: unknown; to?: unknown },
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
    now: Date = new Date(),
  ): Promise<PlatformRevenueReport> {
    const period = parsePeriod(query, now);
    const windows = monthWindows(period.from, period.to, now);
    const periodStart = new Date(windows[0].start);
    const periodEnd = new Date(windows[windows.length - 1].end);

    const [subscriptions, prices] = await Promise.all([
      this.subscriptions(now),
      this.prices(),
    ]);
    const timelines: Timeline[] = subscriptions.map(buildTimeline);
    const [invoices, adjustments, grants] = await Promise.all([
      this.invoices(periodStart, periodEnd),
      this.adjustments(periodStart, periodEnd),
      this.prisma.billingComplimentaryGrant.findMany({
        where: { startedAt: { not: null, lt: periodEnd } },
        orderBy: { id: 'asc' },
        take: MAX_SUBSCRIPTIONS,
        select: {
          subscriptionId: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          previousPlanPriceId: true,
        },
      }),
    ]);

    // --- now, from the subscriptions' own records (authoritative) ---
    const paying = subscriptions
      .filter(payingNow)
      .map((s) => ({ priceId: s.planPriceId!, status: s.status }));
    const current = recurringOf(paying, prices);
    const complimentaryRows = await this.prisma.tenantSubscription.groupBy({
      by: ['billingMode'],
      where: { billingMode: 'COMPLIMENTARY' },
      _count: { _all: true },
    });
    const complimentaryTotal = complimentaryRows[0]?._count._all ?? 0;
    const activeGrants = grants.filter((g) => g.status === 'ACTIVE');
    const equivalent = new Map<string, number>();
    let missingGrantPrices = 0;
    for (const grant of activeGrants) {
      const price = prices.get(grant.previousPlanPriceId);
      if (!price) {
        missingGrantPrices++;
        continue;
      }
      equivalent.set(
        price.currency,
        (equivalent.get(price.currency) ?? 0) + annualMinorUnits(price),
      );
    }

    const complimentaryAt = (at: number) =>
      grants.filter(
        (g) =>
          g.startedAt !== null &&
          g.startedAt.getTime() <= at &&
          (g.finishedAt === null || g.finishedAt.getTime() > at),
      ).length;
    const recoveryOpen = new Set(
      subscriptions
        .filter(
          (s) =>
            s.status === 'TRIAL_EXPIRED' &&
            s.recoveryEndsAt !== null &&
            s.recoveryEndsAt.getTime() > now.getTime(),
        )
        .map((s) => s.id),
    );
    const months = windows.map((window) =>
      monthOf(
        window,
        timelines,
        prices,
        invoices,
        adjustments,
        complimentaryAt,
      ),
    );
    const incomplete = timelines.filter((t) => !t.complete).length;
    const violations = invariantViolations(
      invoices,
      adjustments,
      current.recurring,
      current.byPlan,
    );
    // Prices that couldn't be found — now, in any month, or for a
    // complimentary arrangement — are reported, never counted as zero.
    const missingPrices =
      Math.max(current.missingPrices, ...months.map((m) => m.missingPrices)) +
      missingGrantPrices;
    if (missingPrices > 0) {
      violations.push({ code: 'PRICE_NOT_FOUND', count: missingPrices });
    }

    await this.prisma.platformAuditEvent.create({
      data: {
        action: PLATFORM_AUDIT_ACTIONS.billingRevenueReportViewed,
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId: operator.id,
        reasonCode: `PERIOD_${period.from}_${period.to}`.replace(/-/g, ''),
        requestReference: requestReference ?? null,
      },
    });

    return {
      environment: this.environment(),
      generatedAt: now.toISOString(),
      period,
      current: {
        asOf: now.toISOString(),
        status: current.missingPrices > 0 ? 'INCOMPLETE' : 'COMPLETE',
        recurring: current.recurring,
        byPlan: current.byPlan,
        complimentary: {
          withArrangement: activeGrants.length,
          withoutArrangement: Math.max(
            0,
            complimentaryTotal - activeGrants.length,
          ),
          listPriceEquivalent: [...equivalent.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([currency, arr]) => ({
              currency: currency.toUpperCase(),
              mrrMinorUnits: mrrOf(arr),
            })),
        },
      },
      months,
      trialCohorts: trialCohorts(windows, timelines, (id) =>
        recoveryOpen.has(id),
      ),
      adjustments: adjustmentTotals(
        adjustments,
        periodStart.getTime(),
        periodEnd.getTime(),
      ),
      dataQuality: {
        incompleteSubscriptions: incomplete,
        invoicesWithoutAmounts: invoices.filter(
          (i) =>
            i.taxMinorUnits === null &&
            i.status !== 'draft' &&
            (i.issuedAt >= periodStart ||
              (i.paidAt !== null && i.paidAt >= periodStart)),
        ).length,
        violations,
      },
    };
  }

  // Every subscription that was ever billed (billed now, or complimentary
  // after being billed), with the history that matters for revenue.
  private async subscriptions(now: Date): Promise<SubscriptionInput[]> {
    const where = {
      OR: [
        { billingMode: 'BILLED' as const },
        { complimentaryGrants: { some: {} } },
      ],
    };
    // Refused before anything is loaded, rather than running unbounded.
    if (
      (await this.prisma.tenantSubscription.count({ where })) >
      MAX_SUBSCRIPTIONS
    ) {
      throw tooMany('subscriptions');
    }
    const out: SubscriptionInput[] = [];
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.tenantSubscription.findMany({
        where: {
          OR: [
            { billingMode: 'BILLED' },
            { complimentaryGrants: { some: {} } },
          ],
        },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          createdAt: true,
          billingMode: true,
          status: true,
          planPriceId: true,
          externalSubscriptionId: true,
          currentPeriodStart: true,
          recoveryEndsAt: true,
          events: {
            where: {
              type: { in: [...HISTORY_TYPES] },
              createdAt: { lte: now },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              type: true,
              fromStatus: true,
              toStatus: true,
              planPriceId: true,
              createdAt: true,
            },
          },
          checkoutSessions: {
            where: {
              status: 'COMPLETED',
              completedAt: { not: null, lte: now },
            },
            orderBy: { completedAt: 'asc' },
            select: {
              planPriceId: true,
              completedAt: true,
              replacesExternalSubscriptionId: true,
            },
          },
          complimentaryGrants: {
            select: {
              status: true,
              previousPlanPriceId: true,
              startedAt: true,
              finishedAt: true,
            },
          },
        },
      });
      for (const row of rows) {
        out.push({
          id: row.id,
          createdAt: row.createdAt,
          billingMode: row.billingMode,
          status: row.status,
          planPriceId: row.planPriceId,
          externalSubscriptionId: row.externalSubscriptionId,
          currentPeriodStart: row.currentPeriodStart,
          recoveryEndsAt: row.recoveryEndsAt,
          events: row.events.map((e) => ({
            type: e.type,
            fromStatus: e.fromStatus,
            toStatus: e.toStatus,
            planPriceId: e.planPriceId,
            at: e.createdAt,
          })),
          checkouts: row.checkoutSessions.map((c) => ({
            planPriceId: c.planPriceId,
            completedAt: c.completedAt!,
            replaces: c.replacesExternalSubscriptionId !== null,
          })),
          grants: row.complimentaryGrants,
        });
      }
      if (out.length > MAX_SUBSCRIPTIONS) {
        throw new BadRequestException(
          'Too many subscriptions to report on at once.',
        );
      }
      if (rows.length < BATCH) break;
      cursor = rows[rows.length - 1].id;
    }
    return out;
  }

  // Every plan price (immutable: the subscribed version, never a newer one).
  private async prices(): Promise<Map<string, PriceInfo>> {
    const rows = await this.prisma.subscriptionPlanPrice.findMany({
      select: {
        id: true,
        interval: true,
        currency: true,
        amountMinorUnits: true,
        plan: { select: { name: true } },
      },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          planName: row.plan.name,
          interval: row.interval,
          currency: row.currency.toLowerCase(),
          amountMinorUnits: row.amountMinorUnits,
        },
      ]),
    );
  }

  // Invoices issued or paid in the period.
  private async invoices(from: Date, to: Date): Promise<InvoiceInput[]> {
    const out: InvoiceInput[] = [];
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.billingInvoice.findMany({
        where: {
          provider: this.provider.name,
          OR: [
            { issuedAt: { gte: from, lt: to } },
            { paidAt: { gte: from, lt: to } },
          ],
        },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          status: true,
          currency: true,
          totalMinorUnits: true,
          amountDueMinorUnits: true,
          amountPaidMinorUnits: true,
          balanceAppliedMinorUnits: true,
          taxMinorUnits: true,
          totalExcludingTaxMinorUnits: true,
          attemptCount: true,
          issuedAt: true,
          paidAt: true,
        },
      });
      out.push(...rows);
      if (out.length > MAX_INVOICES) {
        throw new BadRequestException(
          'Too many invoices to report on at once.',
        );
      }
      if (rows.length < BATCH) break;
      cursor = rows[rows.length - 1].id;
    }
    return out;
  }

  // Completed refunds and credits (CENTERIVO-confirmed, or external ones
  // recorded by reconciliation) finished in the period.
  private async adjustments(from: Date, to: Date): Promise<AdjustmentInput[]> {
    const rows = await this.prisma.billingAdjustment.findMany({
      where: {
        status: { in: ['SUCCEEDED', 'RECORDED'] },
        finishedAt: { gte: from, lt: to },
        invoice: { provider: this.provider.name },
      },
      orderBy: { id: 'asc' },
      take: MAX_INVOICES + 1,
      select: {
        invoiceId: true,
        origin: true,
        kind: true,
        currency: true,
        totalMinorUnits: true,
        finishedAt: true,
      },
    });
    if (rows.length > MAX_INVOICES) throw tooMany('refunds and credits');
    return rows.map((row) => ({
      invoiceId: row.invoiceId,
      origin: row.origin as AdjustmentInput['origin'],
      kind: row.kind as AdjustmentInput['kind'],
      currency: row.currency.toLowerCase(),
      totalMinorUnits: row.totalMinorUnits,
      finishedAt: row.finishedAt!,
    }));
  }
}
