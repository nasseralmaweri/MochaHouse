import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  BILLING_COMPLIMENTARY_IN_PROGRESS,
  BILLING_COMPLIMENTARY_NOT_ELIGIBLE,
  BILLING_COMPLIMENTARY_NOT_REVOCABLE,
  BILLING_COMPLIMENTARY_NOT_WITHDRAWABLE,
  BILLING_COMPLIMENTARY_UNPAID_INVOICES,
  BILLING_UNAVAILABLE,
  type PlatformComplimentaryGrantRequest,
  type PlatformComplimentaryGrantView,
  type PlatformComplimentaryListResponse,
  type PlatformComplimentaryView,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializable } from '../../prisma/serializable-transaction';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import type { PlatformOperatorRow } from '../../platform-auth/infrastructure/platform-identity';
import { isUuid } from '../../platform-subscriptions/application/plan-input';
import type { ProviderSubscriptionSnapshot } from '../domain/provider-sync';
import {
  SAAS_BILLING_PROVIDER,
  SaasBillingProviderError,
  type SaasBillingProvider,
} from '../provider/saas-billing-provider';
import { BillingLifecycleService } from './billing-lifecycle.service';

// SC3e-2 — complimentary arrangements (owner decisions D2–D4), by a platform
// operator holding billing.complimentary.manage (and a recent sign-in):
//   * always an EXPLICIT plan version (its modules only), indefinite or
//     until a date (at most three years);
//   * a PAYING business becomes complimentary only at the end of the period
//     it already paid for: the provider subscription is set to cancel at
//     period end (verified by re-reading it), and the grant starts only once
//     the provider confirms that subscription ENDED. Nothing is refunded or
//     credited;
//   * refused while any of the customer's invoices is unpaid (every
//     subscription, current and past — the provider is read), while a plan
//     change, schedule or Checkout is open, or while the subscription is
//     delinquent;
//   * a scheduled grant can be withdrawn (the cancellation undone,
//     verified) until the period ends; a cancellation undone outside
//     CENTERIVO withdraws it and is reviewed — never re-issued;
//   * when a grant expires or is revoked the business returns to billing
//     exactly as it was before (its customer, plan, price and one-trial
//     record): an ended subscription is restarted through a new Checkout, a
//     never-started one through payment setup. Never charged automatically,
//     never a new trial, no provider subscription reactivated or created;
//   * a BILLING suspension is lifted when it starts (enforcement on); a
//     SECURITY or requested suspension never is.
// Every change is transactional, audited, and in the subscription history.
// Nothing here touches restaurant payments or refunds.

const MAX_DURATION_MS = 3 * 365 * 24 * 60 * 60 * 1000;
const MIN_DURATION_MS = 24 * 60 * 60 * 1000;
// A cancellation request not seen at the provider within this window is
// re-sent with the same key; after it, the grant is withdrawn.
const SUBMIT_WINDOW_MS = 30 * 60 * 1000;
const ENDS_SOON_MS = 14 * 24 * 60 * 60 * 1000;
export const COMPLIMENTARY_CANCELLATION_UNDONE_CASE =
  'COMPLIMENTARY_CANCELLATION_UNDONE';
// The paid subscription ended but the grant was not started (unpaid
// invoices, or an unverified ending).
export const COMPLIMENTARY_NOT_STARTED_CASE = 'COMPLIMENTARY_NOT_STARTED';

type Tx = Prisma.TransactionClient;

const GRANT_INCLUDE = {
  planVersion: { include: { plan: true } },
  previousPlanVersion: { include: { plan: true } },
  previousPlanPrice: true,
  grantedBy: { select: { id: true, email: true } },
  finishedBy: { select: { id: true, email: true } },
} as const;
type GrantRow = Prisma.BillingComplimentaryGrantGetPayload<{
  include: typeof GRANT_INCLUDE;
}>;

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: 503,
    error: 'Service Unavailable',
    code: BILLING_UNAVAILABLE,
    message: 'The payment provider is not available. Nothing was changed.',
  });
}

const notEligible = (message: string) =>
  conflict(BILLING_COMPLIMENTARY_NOT_ELIGIBLE, message);

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function parseReason(value: unknown): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (
    reason.length < 10 ||
    reason.length > 500 ||
    hasControlCharacter(reason)
  ) {
    throw new BadRequestException(
      'A reason of 10 to 500 characters (one line) is required.',
    );
  }
  return reason;
}

export function parseGrantRequest(
  body: unknown,
  now: Date = new Date(),
): { planVersionId: string; endsAt: Date | null; reason: string } {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).sort().join(',') !== 'endsAt,planVersionId,reason'
  ) {
    throw new BadRequestException(
      'Send exactly { planVersionId, endsAt, reason }.',
    );
  }
  const input = body as PlatformComplimentaryGrantRequest;
  if (typeof input.planVersionId !== 'string' || !isUuid(input.planVersionId)) {
    throw new BadRequestException('Choose a plan version.');
  }
  let endsAt: Date | null = null;
  if (input.endsAt !== null) {
    endsAt =
      typeof input.endsAt === 'string' ? new Date(input.endsAt) : new Date(NaN);
    if (
      Number.isNaN(endsAt.getTime()) ||
      endsAt.getTime() < now.getTime() + MIN_DURATION_MS ||
      endsAt.getTime() > now.getTime() + MAX_DURATION_MS
    ) {
      throw new BadRequestException(
        'The end date must be between one day and three years from now (or none, for indefinite).',
      );
    }
  }
  return {
    planVersionId: input.planVersionId,
    endsAt,
    reason: parseReason(input.reason),
  };
}

export function parseReasonBody(body: unknown): string {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).join(',') !== 'reason'
  ) {
    throw new BadRequestException('Send exactly { reason }.');
  }
  return parseReason((body as { reason: unknown }).reason);
}

const operatorOrigin = (operator: PlatformOperatorRow) => ({
  source: 'OPERATOR' as const,
  billingProviderEventId: null,
  actorPlatformOperatorId: operator.id,
});
const SYSTEM_ORIGIN = {
  source: 'SYSTEM' as const,
  billingProviderEventId: null,
  actorPlatformOperatorId: null,
};

export const complimentaryIdempotencyKey = (
  grantId: string,
  step: 'cancel' | 'undo',
) => `centerivo-complimentary-${grantId}-${step}`;

@Injectable()
export class BillingComplimentaryService {
  private readonly logger = new Logger(BillingComplimentaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: BillingLifecycleService,
    @Inject(SAAS_BILLING_PROVIDER)
    private readonly provider: SaasBillingProvider,
  ) {}

  // --- reads ----------------------------------------------------------------------

  async view(
    tenantId: string,
    now: Date = new Date(),
  ): Promise<PlatformComplimentaryView> {
    if (!isUuid(tenantId)) throw new NotFoundException('Business not found.');
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { subscriberTenantId: tenantId },
    });
    if (!subscription) throw new NotFoundException('Business not found.');
    const grants = await this.prisma.billingComplimentaryGrant.findMany({
      where: { subscriptionId: subscription.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: GRANT_INCLUDE,
    });
    const current =
      grants.find((g) => g.status === 'SCHEDULED' || g.status === 'ACTIVE') ??
      null;
    return {
      billingMode: subscription.billingMode,
      legacyComplimentary:
        subscription.billingMode === 'COMPLIMENTARY' && current === null,
      current: current ? grantView(current, now) : null,
      history: grants
        .filter((g) => g !== current)
        .map((g) => grantView(g, now)),
      eligibility: await this.localEligibility(subscription, current !== null),
    };
  }

  async list(
    now: Date = new Date(),
  ): Promise<PlatformComplimentaryListResponse> {
    const grants = await this.prisma.billingComplimentaryGrant.findMany({
      where: {
        OR: [
          { status: { in: ['SCHEDULED', 'ACTIVE'] } },
          { finishedAt: { gt: new Date(now.getTime() - 30 * 86_400_000) } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        ...GRANT_INCLUDE,
        subscription: { include: { subscriberTenant: true } },
      },
    });
    const withGrant = await this.prisma.billingComplimentaryGrant.findMany({
      where: { status: 'ACTIVE' },
      select: { subscriptionId: true },
    });
    const legacyComplimentary = await this.prisma.tenantSubscription.count({
      where: {
        billingMode: 'COMPLIMENTARY',
        id: { notIn: withGrant.map((g) => g.subscriptionId) },
      },
    });
    return {
      grants: grants.map((g) => ({
        ...grantView(g, now),
        tenantId: g.subscription.subscriberTenantId,
        businessName: g.subscription.subscriberTenant.name,
      })),
      legacyComplimentary,
    };
  }

  // What our records already rule out (the provider is read when granting).
  private async localEligibility(
    subscription: Prisma.TenantSubscriptionGetPayload<object>,
    open: boolean,
  ): Promise<{ eligible: boolean; reason: string | null }> {
    if (open) return { eligible: false, reason: 'A grant is already open.' };
    if (subscription.billingMode !== 'BILLED') {
      return {
        eligible: false,
        reason: 'Already complimentary (no billing to replace).',
      };
    }
    // SC4b — a self-service business whose billing was never started with
    // the provider (payment setup pending).
    if (subscription.billingProvider === null) {
      return {
        eligible: false,
        reason: 'Billing has not been started with the payment provider yet.',
      };
    }
    if (
      subscription.status === 'PAST_DUE' ||
      subscription.status === 'UNPAID'
    ) {
      return {
        eligible: false,
        reason: 'Payment is outstanding; it must be settled first.',
      };
    }
    if (
      subscription.pendingChangeKind !== null ||
      subscription.cancelAtPeriodEnd
    ) {
      return {
        eligible: false,
        reason: 'A plan change or cancellation is pending.',
      };
    }
    const [openChange, openCheckout] = await Promise.all([
      this.prisma.billingPlanChange.count({
        where: {
          subscriptionId: subscription.id,
          status: {
            in: ['REQUESTED', 'AWAITING_PAYMENT', 'SCHEDULED', 'REVIEW'],
          },
        },
      }),
      this.prisma.billingCheckoutSession.count({
        where: { subscriptionId: subscription.id, status: 'OPEN' },
      }),
    ]);
    if (openChange > 0) {
      return { eligible: false, reason: 'A plan change is in progress.' };
    }
    if (openCheckout > 0) {
      return { eligible: false, reason: 'A payment setup page is open.' };
    }
    return { eligible: true, reason: null };
  }

  // --- grant ----------------------------------------------------------------------

  async grant(
    tenantId: string,
    input: { planVersionId: string; endsAt: Date | null; reason: string },
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
    now: Date = new Date(),
  ): Promise<PlatformComplimentaryView> {
    if (!isUuid(tenantId)) throw new NotFoundException('Business not found.');
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { subscriberTenantId: tenantId },
    });
    if (!subscription) throw new NotFoundException('Business not found.');
    const local = await this.localEligibility(
      subscription,
      (await this.prisma.billingComplimentaryGrant.count({
        where: {
          subscriptionId: subscription.id,
          status: { in: ['SCHEDULED', 'ACTIVE'] },
        },
      })) > 0,
    );
    if (!local.eligible) {
      throw (local.reason ?? '').startsWith('Payment')
        ? conflict(BILLING_COMPLIMENTARY_UNPAID_INVOICES, local.reason!)
        : local.reason === 'A grant is already open.'
          ? conflict(BILLING_COMPLIMENTARY_IN_PROGRESS, local.reason)
          : notEligible(local.reason ?? 'Not eligible.');
    }
    const version = await this.prisma.subscriptionPlanVersion.findUnique({
      where: { id: input.planVersionId },
      select: { id: true, status: true },
    });
    if (!version || version.status !== 'PUBLISHED') {
      throw new BadRequestException('Choose a published plan version.');
    }
    if (
      !this.provider.available ||
      subscription.billingProvider !== this.provider.name ||
      subscription.externalCustomerId === null ||
      subscription.planPriceId === null
    ) {
      throw unavailable();
    }

    // The provider decides: no unpaid invoice anywhere on the customer; the
    // subscription ours and either still paid for (then: at period end) or
    // already ended (then: now).
    let snapshot: ProviderSubscriptionSnapshot | null = null;
    try {
      const unpaid = await this.provider.listUnpaidCustomerInvoices(
        subscription.externalCustomerId,
      );
      if (unpaid.some((invoice) => invoice.amountDueMinorUnits > 0)) {
        throw conflict(
          BILLING_COMPLIMENTARY_UNPAID_INVOICES,
          'This business has unpaid invoices at the payment provider. They must be paid (or adjusted in a later release) first; nothing was changed.',
        );
      }
      if (subscription.externalSubscriptionId !== null) {
        snapshot = await this.provider.retrieveSubscription(
          subscription.externalSubscriptionId,
        );
      }
    } catch (error) {
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }
    let scheduled: { effectiveAt: Date } | null = null;
    if (snapshot !== null) {
      if (
        snapshot.externalSubscriptionId !==
          subscription.externalSubscriptionId ||
        snapshot.externalCustomerId !== subscription.externalCustomerId ||
        snapshot.livemode !== this.provider.livemode
      ) {
        throw notEligible(
          "The payment provider's subscription does not match our records.",
        );
      }
      if (snapshot.status === 'active' || snapshot.status === 'trialing') {
        const end =
          snapshot.status === 'trialing'
            ? (snapshot.trialEnd ?? null)
            : (snapshot.currentPeriodEnd ?? null);
        if (
          end === null ||
          snapshot.scheduleId != null ||
          snapshot.hasPendingUpdate === true ||
          snapshot.cancelAtPeriodEnd
        ) {
          throw notEligible(
            'The subscription has a schedule, a pending update or a cancellation at the payment provider.',
          );
        }
        scheduled = { effectiveAt: end };
      } else if (!(
        snapshot.status === 'canceled' ||
        snapshot.status === 'incomplete_expired'
      )) {
        throw notEligible(
          `The provider subscription is ${snapshot.status}; it must be active or ended.`,
        );
      }
    }

    const previous = {
      previousStatus: subscription.status,
      previousPlanVersionId: subscription.planVersionId,
      previousPlanPriceId: subscription.planPriceId,
      previousBillingProvider: subscription.billingProvider,
      previousExternalCustomerId: subscription.externalCustomerId,
      previousExternalSubscriptionId: subscription.externalSubscriptionId,
      previousTrialStartedAt: subscription.trialStartedAt,
      previousTrialEndsAt: subscription.trialEndsAt,
      previousTrialRequiresPaymentMethod:
        subscription.trialRequiresPaymentMethod,
    };
    let grantId: string;
    try {
      grantId = await runSerializable(this.prisma, async (tx) => {
        const fresh = await tx.tenantSubscription.findUniqueOrThrow({
          where: { id: subscription.id },
          select: { billingStateVersion: true },
        });
        if (fresh.billingStateVersion !== subscription.billingStateVersion) {
          throw conflict(
            BILLING_COMPLIMENTARY_IN_PROGRESS,
            'The subscription changed meanwhile. Reload and try again.',
          );
        }
        const created = await tx.billingComplimentaryGrant.create({
          data: {
            subscriptionId: subscription.id,
            status: scheduled ? 'SCHEDULED' : 'ACTIVE',
            planVersionId: input.planVersionId,
            endsAt: input.endsAt,
            reason: input.reason,
            grantedByOperatorId: operator.id,
            ...previous,
            effectiveAt: scheduled?.effectiveAt ?? null,
            startedAt: scheduled ? null : now,
          },
          select: { id: true, subscriptionId: true, planVersionId: true },
        });
        if (scheduled) {
          await this.lifecycle.recordComplimentarySchedule(
            tx,
            subscription.id,
            'COMPLIMENTARY_SCHEDULED',
            subscription.cancelAtPeriodEnd,
            operatorOrigin(operator),
          );
        } else {
          await this.lifecycle.startComplimentary(
            tx,
            created,
            operatorOrigin(operator),
          );
        }
        await tx.platformAuditEvent.create({
          data: {
            action: PLATFORM_AUDIT_ACTIONS.billingComplimentaryGranted,
            outcome: 'SUCCEEDED',
            actorPlatformOperatorId: operator.id,
            reasonCode: scheduled ? 'AT_PERIOD_END' : 'IMMEDIATE',
            targetType: 'tenant',
            targetId: tenantId,
            requestReference: requestReference ?? null,
          },
        });
        return created.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          BILLING_COMPLIMENTARY_IN_PROGRESS,
          'A complimentary arrangement is already open for this business.',
        );
      }
      throw error;
    }

    if (scheduled) {
      // The cancellation at period end, then verified by re-reading. A
      // provider error leaves the grant waiting: the sweep re-sends it (the
      // same key) or, past its window, withdraws it.
      try {
        await this.provider.setCancelAtPeriodEnd({
          idempotencyKey: complimentaryIdempotencyKey(grantId, 'cancel'),
          externalSubscriptionId: subscription.externalSubscriptionId!,
          cancelAtPeriodEnd: true,
        });
      } catch (error) {
        if (!(error instanceof SaasBillingProviderError)) throw error;
        this.logger.warn(
          `Complimentary grant ${grantId}: cancellation not confirmed yet (${error.code}).`,
        );
      }
      // Verified now (never re-sent here: the request was just made).
      await this.settle(grantId, now, { resend: false });
    }
    return this.view(tenantId, now);
  }

  // --- withdraw / revoke -------------------------------------------------------------

  // A SCHEDULED grant is withdrawn before the paid period ends: the
  // cancellation is undone at the provider (verified), and nothing changes
  // for the business.
  async withdraw(
    tenantId: string,
    grantId: string,
    reason: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformComplimentaryView> {
    const grant = await this.ownGrant(tenantId, grantId);
    if (grant.status !== 'SCHEDULED') {
      throw conflict(
        BILLING_COMPLIMENTARY_NOT_WITHDRAWABLE,
        'Only a scheduled arrangement (not started yet) can be withdrawn.',
      );
    }
    if (!this.provider.available) throw unavailable();
    const externalSubscriptionId = grant.previousExternalSubscriptionId!;
    try {
      const before = await this.provider.retrieveSubscription(
        externalSubscriptionId,
      );
      if (
        before.status === 'canceled' ||
        before.status === 'incomplete_expired'
      ) {
        throw conflict(
          BILLING_COMPLIMENTARY_NOT_WITHDRAWABLE,
          'The paid period has already ended; the arrangement is starting.',
        );
      }
      if (before.cancelAtPeriodEnd) {
        await this.provider.setCancelAtPeriodEnd({
          idempotencyKey: complimentaryIdempotencyKey(grant.id, 'undo'),
          externalSubscriptionId,
          cancelAtPeriodEnd: false,
        });
        const after = await this.provider.retrieveSubscription(
          externalSubscriptionId,
        );
        if (after.cancelAtPeriodEnd) {
          throw new SaasBillingProviderError('cancellation_not_undone');
        }
      }
    } catch (error) {
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }
    await runSerializable(this.prisma, async (tx) => {
      const { count } = await tx.billingComplimentaryGrant.updateMany({
        where: { id: grant.id, status: 'SCHEDULED' },
        data: {
          status: 'WITHDRAWN',
          finishedAt: new Date(),
          finishCode: 'WITHDRAWN',
          finishReason: reason,
          finishedByOperatorId: operator.id,
        },
      });
      if (count !== 1) {
        throw conflict(
          BILLING_COMPLIMENTARY_NOT_WITHDRAWABLE,
          'The arrangement changed meanwhile. Reload and try again.',
        );
      }
      await this.lifecycle.recordComplimentarySchedule(
        tx,
        grant.subscriptionId,
        'COMPLIMENTARY_WITHDRAWN',
        false,
        operatorOrigin(operator),
      );
      await tx.platformAuditEvent.create({
        data: {
          action: PLATFORM_AUDIT_ACTIONS.billingComplimentaryWithdrawn,
          outcome: 'SUCCEEDED',
          actorPlatformOperatorId: operator.id,
          reasonCode: 'WITHDRAWN',
          targetType: 'tenant',
          targetId: tenantId,
          requestReference: requestReference ?? null,
        },
      });
    });
    return this.view(tenantId);
  }

  // An ACTIVE grant is ended early by an operator.
  async revoke(
    tenantId: string,
    grantId: string,
    reason: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
    now: Date = new Date(),
  ): Promise<PlatformComplimentaryView> {
    const grant = await this.ownGrant(tenantId, grantId);
    if (grant.status !== 'ACTIVE') {
      throw conflict(
        BILLING_COMPLIMENTARY_NOT_REVOCABLE,
        'Only an active arrangement can be revoked (a scheduled one is withdrawn).',
      );
    }
    await runSerializable(this.prisma, (tx) =>
      this.end(tx, grant.id, 'REVOKED', now, {
        operator,
        reason,
        tenantId,
        requestReference,
      }),
    );
    return this.view(tenantId, now);
  }

  private async ownGrant(tenantId: string, grantId: string) {
    if (!isUuid(tenantId) || !isUuid(grantId)) {
      throw new NotFoundException('Arrangement not found.');
    }
    const grant = await this.prisma.billingComplimentaryGrant.findFirst({
      where: { id: grantId, subscription: { subscriberTenantId: tenantId } },
    });
    if (!grant) throw new NotFoundException('Arrangement not found.');
    return grant;
  }

  // Ends an ACTIVE grant (expired or revoked): the business returns to
  // billing as it was (BillingLifecycleService.endComplimentary).
  private async end(
    tx: Tx,
    grantId: string,
    code: 'EXPIRED' | 'REVOKED',
    now: Date,
    by: {
      operator: PlatformOperatorRow;
      reason: string;
      tenantId: string;
      requestReference: string | undefined;
    } | null,
  ): Promise<boolean> {
    const grant = await tx.billingComplimentaryGrant.findUniqueOrThrow({
      where: { id: grantId },
    });
    if (grant.status !== 'ACTIVE') return false;
    const subscription = await tx.tenantSubscription.findUniqueOrThrow({
      where: { id: grant.subscriptionId },
      select: { billingMode: true },
    });
    const superseded = subscription.billingMode !== 'COMPLIMENTARY';
    await tx.billingComplimentaryGrant.update({
      where: { id: grant.id },
      data: {
        status: 'ENDED',
        finishedAt: now,
        finishCode: superseded ? 'SUPERSEDED' : code,
        finishReason: by?.reason ?? null,
        finishedByOperatorId: by?.operator.id ?? null,
      },
    });
    if (!superseded) {
      await this.lifecycle.endComplimentary(
        tx,
        grant,
        now,
        by ? operatorOrigin(by.operator) : SYSTEM_ORIGIN,
      );
    }
    await tx.platformAuditEvent.create({
      data: {
        action: PLATFORM_AUDIT_ACTIONS.billingComplimentaryEnded,
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId: by?.operator.id ?? null,
        reasonCode: code,
        targetType: 'tenant',
        targetId:
          by?.tenantId ??
          (
            await tx.tenantSubscription.findUniqueOrThrow({
              where: { id: grant.subscriptionId },
              select: { subscriberTenantId: true },
            })
          ).subscriberTenantId,
        requestReference: by?.requestReference ?? null,
      },
    });
    return true;
  }

  // --- settlement (verification, start, expiry) -------------------------------------

  // A SCHEDULED grant against the provider's LIVE subscription:
  //   ended            -> the grant starts (the paid period is over);
  //   cancel scheduled -> verified (once);
  //   not scheduled    -> never verified: re-sent within the window, else
  //                       withdrawn (NOT_SUBMITTED); verified before: undone
  //                       outside CENTERIVO -> withdrawn and reviewed (never
  //                       re-issued).
  // An ACTIVE grant past its end date expires.
  async settle(
    grantId: string,
    now: Date = new Date(),
    options: { resend: boolean } = { resend: true },
  ): Promise<
    'STARTED' | 'VERIFIED' | 'WAITING' | 'WITHDRAWN' | 'ENDED' | 'NONE'
  > {
    const grant = await this.prisma.billingComplimentaryGrant.findUniqueOrThrow(
      {
        where: { id: grantId },
      },
    );
    if (grant.status === 'ACTIVE') {
      if (grant.endsAt === null || grant.endsAt.getTime() > now.getTime()) {
        return 'NONE';
      }
      const ended = await runSerializable(this.prisma, (tx) =>
        this.end(tx, grant.id, 'EXPIRED', now, null),
      );
      return ended ? 'ENDED' : 'NONE';
    }
    if (grant.status !== 'SCHEDULED' || !this.provider.available) return 'NONE';
    const externalSubscriptionId = grant.previousExternalSubscriptionId!;
    let snapshot: ProviderSubscriptionSnapshot;
    try {
      snapshot = await this.provider.retrieveSubscription(
        externalSubscriptionId,
      );
    } catch (error) {
      if (error instanceof SaasBillingProviderError) return 'WAITING';
      throw error;
    }
    if (
      snapshot.externalSubscriptionId !== externalSubscriptionId ||
      snapshot.externalCustomerId !== grant.previousExternalCustomerId ||
      snapshot.livemode !== this.provider.livemode
    ) {
      return 'WAITING';
    }
    if (
      snapshot.status === 'canceled' ||
      snapshot.status === 'incomplete_expired'
    ) {
      // Owner decision D3 — debt is never waived: a subscription the
      // provider ended while invoices are unpaid (e.g. dunning after a failed
      // renewal) does not become complimentary; reviewed instead.
      let unpaid: boolean;
      try {
        unpaid = (
          await this.provider.listUnpaidCustomerInvoices(
            grant.previousExternalCustomerId,
          )
        ).some((invoice) => invoice.amountDueMinorUnits > 0);
      } catch (error) {
        if (error instanceof SaasBillingProviderError) return 'WAITING';
        throw error;
      }
      if (unpaid || grant.cancelVerifiedAt === null) {
        await this.withdrawBySystem(
          grant.id,
          unpaid ? 'UNPAID_AT_END' : 'ENDED_UNVERIFIED',
          COMPLIMENTARY_NOT_STARTED_CASE,
          unpaid
            ? `Complimentary grant ${grant.id}: the paid subscription ${externalSubscriptionId} ended with unpaid invoices. The grant was NOT started (debt is never waived); settle the invoices, then grant again.`
            : `Complimentary grant ${grant.id}: the subscription ${externalSubscriptionId} ended before its cancellation at period end was verified. The grant was NOT started.`,
        );
        return 'WITHDRAWN';
      }
      const started = await runSerializable(this.prisma, async (tx) => {
        const { count } = await tx.billingComplimentaryGrant.updateMany({
          where: { id: grant.id, status: 'SCHEDULED' },
          data: {
            status: 'ACTIVE',
            startedAt: now,
            ...(grant.cancelVerifiedAt ? {} : { cancelVerifiedAt: now }),
          },
        });
        if (count !== 1) return false;
        await this.lifecycle.startComplimentary(tx, grant, SYSTEM_ORIGIN);
        await this.systemAudit(
          tx,
          PLATFORM_AUDIT_ACTIONS.billingComplimentaryStarted,
          'PERIOD_ENDED',
          grant.subscriptionId,
        );
        return true;
      });
      return started ? 'STARTED' : 'NONE';
    }
    if (snapshot.cancelAtPeriodEnd) {
      if (grant.cancelVerifiedAt !== null) return 'WAITING';
      await runSerializable(this.prisma, async (tx) => {
        const { count } = await tx.billingComplimentaryGrant.updateMany({
          where: { id: grant.id, status: 'SCHEDULED', cancelVerifiedAt: null },
          data: { cancelVerifiedAt: now },
        });
        // Our subscription follows the verified provider state at once.
        if (count === 1) {
          await this.lifecycle.syncCancelAtPeriodEnd(
            tx,
            grant.subscriptionId,
            true,
            SYSTEM_ORIGIN,
          );
        }
      });
      return 'VERIFIED';
    }
    // Not (or no longer) set to cancel at the provider.
    if (grant.cancelVerifiedAt === null) {
      if (now.getTime() - grant.createdAt.getTime() < SUBMIT_WINDOW_MS) {
        if (!options.resend) return 'WAITING';
        try {
          await this.provider.setCancelAtPeriodEnd({
            idempotencyKey: complimentaryIdempotencyKey(grant.id, 'cancel'),
            externalSubscriptionId,
            cancelAtPeriodEnd: true,
          });
        } catch (error) {
          if (!(error instanceof SaasBillingProviderError)) throw error;
        }
        return 'WAITING';
      }
      await this.withdrawBySystem(grant.id, 'NOT_SUBMITTED', null, null);
      return 'WITHDRAWN';
    }
    await this.withdrawBySystem(
      grant.id,
      'PROVIDER_UNDONE',
      COMPLIMENTARY_CANCELLATION_UNDONE_CASE,
      `Complimentary grant ${grant.id}: the provider subscription ${externalSubscriptionId} is no longer set to cancel at period end (undone outside CENTERIVO). The grant was withdrawn and the cancellation was NOT re-issued.`,
    );
    return 'WITHDRAWN';
  }

  private async withdrawBySystem(
    grantId: string,
    code:
      | 'NOT_SUBMITTED'
      | 'PROVIDER_UNDONE'
      | 'UNPAID_AT_END'
      | 'ENDED_UNVERIFIED',
    caseKind: string | null,
    caseDetail: string | null,
  ): Promise<void> {
    await runSerializable(this.prisma, async (tx) => {
      const grant = await tx.billingComplimentaryGrant.findUniqueOrThrow({
        where: { id: grantId },
      });
      const { count } = await tx.billingComplimentaryGrant.updateMany({
        where: { id: grantId, status: 'SCHEDULED' },
        data: { status: 'WITHDRAWN', finishedAt: new Date(), finishCode: code },
      });
      if (count !== 1) return;
      await this.lifecycle.recordComplimentarySchedule(
        tx,
        grant.subscriptionId,
        'COMPLIMENTARY_WITHDRAWN',
        false,
        SYSTEM_ORIGIN,
      );
      if (caseKind !== null && caseDetail !== null) {
        await this.lifecycle.openCase(
          tx,
          caseKind,
          grant.subscriptionId,
          null,
          caseDetail.slice(0, 500),
        );
      }
      await this.systemAudit(
        tx,
        PLATFORM_AUDIT_ACTIONS.billingComplimentaryWithdrawn,
        code,
        grant.subscriptionId,
      );
    });
  }

  // A platform audit event for a change the system made (no operator).
  private async systemAudit(
    tx: Tx,
    action: string,
    reasonCode: string,
    subscriptionId: string,
  ): Promise<void> {
    const { subscriberTenantId } =
      await tx.tenantSubscription.findUniqueOrThrow({
        where: { id: subscriptionId },
        select: { subscriberTenantId: true },
      });
    await tx.platformAuditEvent.create({
      data: {
        action,
        outcome: 'SUCCEEDED',
        reasonCode,
        targetType: 'tenant',
        targetId: subscriberTenantId,
      },
    });
  }

  // The sweep: every SCHEDULED grant, and every ACTIVE one past its end.
  async sweep(now: Date = new Date()): Promise<{ settled: number }> {
    const due = await this.prisma.billingComplimentaryGrant.findMany({
      where: {
        OR: [
          { status: 'SCHEDULED' },
          { status: 'ACTIVE', endsAt: { lte: now } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true },
    });
    let settled = 0;
    for (const grant of due) {
      try {
        const outcome = await this.settle(grant.id, now);
        if (outcome !== 'NONE' && outcome !== 'WAITING') settled++;
      } catch (error) {
        this.logger.error(
          `Complimentary grant ${grant.id} settlement failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
    }
    return { settled };
  }

  // A verified provider event on a subscription with a SCHEDULED grant (the
  // webhook path; the sweep is the backstop).
  async settleForSubscription(
    externalSubscriptionId: string | null,
    now: Date = new Date(),
  ): Promise<void> {
    if (externalSubscriptionId === null) return;
    const grant = await this.prisma.billingComplimentaryGrant.findFirst({
      where: {
        status: 'SCHEDULED',
        previousExternalSubscriptionId: externalSubscriptionId,
      },
      select: { id: true },
    });
    if (grant) await this.settle(grant.id, now);
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as {
    code?: unknown;
    cause?: { originalCode?: unknown; code?: unknown };
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  return (
    e.code === 'P2002' ||
    e.cause?.originalCode === '23505' ||
    e.cause?.code === '23505' ||
    e.meta?.driverAdapterError?.cause?.originalCode === '23505'
  );
}

export function grantView(
  grant: GrantRow,
  now: Date,
): PlatformComplimentaryGrantView {
  const attention: PlatformComplimentaryGrantView['attention'] =
    grant.status === 'SCHEDULED' && grant.cancelVerifiedAt === null
      ? 'CANCELLATION_UNVERIFIED'
      : grant.status === 'ACTIVE' &&
          grant.endsAt !== null &&
          grant.endsAt.getTime() - now.getTime() < ENDS_SOON_MS
        ? 'ENDS_SOON'
        : null;
  return {
    id: grant.id,
    status: grant.status as PlatformComplimentaryGrantView['status'],
    plan: {
      planName: grant.planVersion.plan.name,
      versionId: grant.planVersion.id,
      version: grant.planVersion.version,
      moduleKeys: grant.planVersion.moduleKeys,
    },
    endsAt: grant.endsAt?.toISOString() ?? null,
    reason: grant.reason,
    grantedBy: grant.grantedBy,
    createdAt: grant.createdAt.toISOString(),
    previousStatus: grant.previousStatus,
    previousPlanName: grant.previousPlanVersion.plan.name,
    previousPrice: {
      amountMinorUnits: grant.previousPlanPrice.amountMinorUnits,
      currency: grant.previousPlanPrice.currency,
      interval: grant.previousPlanPrice.interval,
    },
    effectiveAt: grant.effectiveAt?.toISOString() ?? null,
    cancellationVerified: grant.cancelVerifiedAt !== null,
    startedAt: grant.startedAt?.toISOString() ?? null,
    finishedAt: grant.finishedAt?.toISOString() ?? null,
    finishCode: grant.finishCode,
    finishReason: grant.finishReason,
    finishedBy: grant.finishedBy,
    attention,
  };
}
