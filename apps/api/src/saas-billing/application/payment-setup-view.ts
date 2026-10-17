import type {
  BusinessBillingSummary,
  PlatformPaymentSetupListResponse,
  PlatformPaymentSetupView,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import { billingEnforcementEnabled } from './billing-enforcement.config';
import { latestDeadline, needsPaymentSetup } from '../domain/payment-setup';

// SC3e-4 — what the business and operators see of payment setup. A deadline
// is shown ONLY while billing enforcement is on (never one that wouldn't
// apply); "since" is informational either way.

type Db = Pick<
  Prisma.TransactionClient,
  'billingGraceExtension' | 'tenantSubscription'
>;

interface SetupRow {
  id: string;
  billingMode: 'BILLED' | 'COMPLIMENTARY';
  status: string;
  externalSubscriptionId: string | null;
  recurringPaymentAuthorizedAt: Date | null;
  currentPeriodStart: Date | null;
  paymentSetupRequiredSince: Date | null;
  paymentSetupWindowStartedAt: Date | null;
  paymentSetupDueAt: Date | null;
  paymentSetupExpiredAt: Date | null;
}

export function paymentSetupSummary(
  row: SetupRow,
  planKey: string,
  suspendedForBilling: boolean,
): BusinessBillingSummary['paymentSetup'] {
  const enforced = billingEnforcementEnabled();
  const required = needsPaymentSetup(row, planKey);
  return {
    required,
    since: required
      ? (row.paymentSetupRequiredSince?.toISOString() ?? null)
      : null,
    deadline:
      required && enforced && row.paymentSetupExpiredAt === null
        ? (row.paymentSetupDueAt?.toISOString() ?? null)
        : null,
    expired: row.paymentSetupExpiredAt !== null && suspendedForBilling,
  };
}

export async function paymentSetupView(
  db: Db,
  row: SetupRow,
  planKey: string,
): Promise<PlatformPaymentSetupView | null> {
  if (!needsPaymentSetup(row, planKey) && row.paymentSetupExpiredAt === null) {
    return null;
  }
  const enforced = billingEnforcementEnabled();
  const start = row.paymentSetupWindowStartedAt;
  const extensions =
    start === null
      ? []
      : await db.billingGraceExtension.findMany({
          where: {
            subscriptionId: row.id,
            kind: 'PAYMENT_SETUP',
            episodeStartedAt: start,
          },
          orderBy: { createdAt: 'asc' },
          take: 20,
          include: { actorPlatformOperator: { select: { email: true } } },
        });
  return {
    enforced,
    since: (row.paymentSetupRequiredSince ?? new Date()).toISOString(),
    windowStartedAt: enforced && start ? start.toISOString() : null,
    deadline: enforced ? (row.paymentSetupDueAt?.toISOString() ?? null) : null,
    latestDeadline:
      enforced && start ? latestDeadline(start).toISOString() : null,
    expired: row.paymentSetupExpiredAt !== null,
    extensions: extensions.map((e) => ({
      id: e.id,
      kind: 'PAYMENT_SETUP' as const,
      days: e.days,
      previousEndsAt: e.previousEndsAt.toISOString(),
      newEndsAt: e.newEndsAt.toISOString(),
      reason: e.reason,
      createdAt: e.createdAt.toISOString(),
      operatorEmail: e.actorPlatformOperator.email,
    })),
  };
}

// Every billed business that needs payment setup (bounded), soonest
// deadline first, then longest waiting.
export async function paymentSetupList(
  db: Db,
  limit = 200,
): Promise<PlatformPaymentSetupListResponse> {
  const rows = await db.tenantSubscription.findMany({
    where: {
      billingMode: 'BILLED',
      // Founding never needs setup (never crowds out the list).
      planVersion: { plan: { key: { not: 'founding' } } },
      OR: [
        {
          status: 'ACTIVE',
          OR: [
            { externalSubscriptionId: null },
            { recurringPaymentAuthorizedAt: null },
            { currentPeriodStart: null },
          ],
        },
        { paymentSetupExpiredAt: { not: null } },
      ],
    },
    orderBy: [
      { paymentSetupDueAt: { sort: 'asc', nulls: 'last' } },
      { paymentSetupRequiredSince: 'asc' },
      { id: 'asc' },
    ],
    take: limit,
    include: {
      planVersion: { select: { plan: { select: { key: true, name: true } } } },
      subscriberTenant: { select: { name: true } },
    },
  });
  const items: PlatformPaymentSetupListResponse['items'] = [];
  for (const row of rows) {
    const view = await paymentSetupView(db, row, row.planVersion.plan.key);
    if (!view) continue;
    items.push({
      ...view,
      tenantId: row.subscriberTenantId,
      businessName: row.subscriberTenant.name,
      planName: row.planVersion.plan.name,
    });
  }
  return { enforced: billingEnforcementEnabled(), items };
}
