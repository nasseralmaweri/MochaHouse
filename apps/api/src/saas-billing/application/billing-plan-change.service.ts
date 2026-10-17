import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  BILLING_PLAN_CHANGE_CURRENCY,
  BILLING_PLAN_CHANGE_IN_PROGRESS,
  BILLING_PLAN_CHANGE_SAME_PRICE,
  BILLING_PLAN_CHANGE_UNAVAILABLE,
  BILLING_PLAN_CHANGE_UNVERIFIED,
  BILLING_UNAVAILABLE,
  type BillingPlanChangePreview,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializable } from '../../prisma/serializable-transaction';
import { InternalAuditService } from '../../audit/internal-audit.service';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import { isUuid } from '../../platform-subscriptions/application/plan-input';
import {
  PLAN_CHANGE_PREVIEW_TTL_MS,
  planChangeTiming,
  verifyBilledPrice,
  type PlanChangeTiming,
} from '../domain/plan-change';
import type { ProviderSubscriptionSnapshot } from '../domain/provider-sync';
import {
  SAAS_BILLING_PROVIDER,
  SaasBillingProviderError,
  type ProviderChargePreview,
  type SaasBillingProvider,
} from '../provider/saas-billing-provider';
import { BillingLifecycleService } from './billing-lifecycle.service';
import { syncProviderPrice } from './price-sync';

// SC3d-1 — previewing a change of a BILLED business's plan or price. Nothing
// is charged and nothing changes: the provider calculates the charge (its
// own proration, tax, credits and discounts — never ours), and the preview
// is recorded (BillingPlanChange, PREVIEWED, valid 10 minutes) so a later
// confirmation (SC3d-2) can only ever be for exactly what was shown.
//
// Every identifier comes from OUR records: the business from the trusted
// context (the staff member's business, or the operator's checked route
// parameter), the target price by OUR id (never a provider id), the
// subscription item and prices from the provider read through our stored
// subscription id. The provider must bill exactly what our records say —
// otherwise the preview is refused and a PRICE_MISMATCH case is opened.

export const PRICE_MISMATCH_CASE = 'PRICE_MISMATCH';

// Previews kept per business per hour (each is a provider call and a row).
export const PLAN_CHANGE_PREVIEWS_PER_HOUR = 30;

export type PlanChangeActor =
  | { kind: 'STAFF'; internalUserId: string }
  | {
      kind: 'OPERATOR';
      platformOperatorId: string;
      requestReference: string | null;
    };

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
    message: 'Billing is not available right now. Nothing was changed.',
  });
}

const notChangeable = () =>
  conflict(
    BILLING_PLAN_CHANGE_UNAVAILABLE,
    "This subscription can't be changed right now. Plans can be changed while the subscription is active or in its trial, and the business is not paused.",
  );

export function parsePlanChangePreview(body: unknown): string {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).join(',') !== 'planPriceId'
  ) {
    throw new BadRequestException('Choose one price (planPriceId).');
  }
  const value = (body as { planPriceId: unknown }).planPriceId;
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new BadRequestException('Choose one price (planPriceId).');
  }
  return value;
}

const SUBSCRIPTION_INCLUDE = {
  planVersion: { include: { plan: true } },
  planPrice: true,
  subscriberTenant: { select: { status: true } },
} as const;

@Injectable()
export class BillingPlanChangeService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SAAS_BILLING_PROVIDER)
    private readonly provider: SaasBillingProvider,
    private readonly lifecycle: BillingLifecycleService,
    private readonly audit: InternalAuditService,
  ) {}

  async preview(
    tenantId: string,
    planPriceId: string,
    actor: PlanChangeActor,
    now: Date = new Date(),
  ): Promise<BillingPlanChangePreview> {
    if (!isUuid(tenantId)) throw new NotFoundException('Business not found.');
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { subscriberTenantId: tenantId },
      include: SUBSCRIPTION_INCLUDE,
    });
    if (!subscription) throw new NotFoundException('Business not found.');
    const current = subscription.planPrice;
    if (
      subscription.billingMode !== 'BILLED' ||
      subscription.externalSubscriptionId === null ||
      current === null ||
      subscription.planVersion.plan.key === 'founding' ||
      subscription.subscriberTenant.status !== 'ACTIVE' ||
      subscription.cancelAtPeriodEnd
    ) {
      throw notChangeable();
    }
    if (
      subscription.billingProvider !== this.provider.name ||
      !this.provider.available
    ) {
      throw unavailable();
    }

    // The target: one of OUR active prices, of a plan that is offered (a
    // published version; never the Founding plan).
    const target = await this.prisma.subscriptionPlanPrice.findUnique({
      where: { id: planPriceId },
      include: { plan: true },
    });
    if (!target) throw new NotFoundException('Price not found.');
    const targetVersion = await this.prisma.subscriptionPlanVersion.findFirst({
      where: { planId: target.planId, status: 'PUBLISHED' },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    if (
      target.status !== 'ACTIVE' ||
      targetVersion === null ||
      target.plan.key === 'founding'
    ) {
      throw notChangeable();
    }

    const rule = planChangeTiming(subscription.status, current, target);
    if (!rule.ok) {
      if (rule.reason === 'SAME_PRICE') {
        throw conflict(
          BILLING_PLAN_CHANGE_SAME_PRICE,
          'That is the current price.',
        );
      }
      if (rule.reason === 'CURRENCY_MISMATCH') {
        throw conflict(
          BILLING_PLAN_CHANGE_CURRENCY,
          "That price is in another currency than this subscription's.",
        );
      }
      throw notChangeable();
    }
    const timing = rule.timing;

    // A change already in flight (ours, or the lifecycle's pending change).
    const open = await this.prisma.billingPlanChange.findFirst({
      where: {
        subscriptionId: subscription.id,
        status: {
          in: ['REQUESTED', 'AWAITING_PAYMENT', 'SCHEDULED', 'REVIEW'],
        },
      },
      select: { id: true },
    });
    if (open || subscription.pendingChangeKind !== null) {
      throw conflict(
        BILLING_PLAN_CHANGE_IN_PROGRESS,
        'A plan change is already in progress for this business.',
      );
    }

    // A bounded number of previews per business (each calls the provider
    // and is kept): beyond it, wait.
    const recent = await this.prisma.billingPlanChange.count({
      where: {
        subscriptionId: subscription.id,
        createdAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) },
      },
    });
    if (recent >= PLAN_CHANGE_PREVIEWS_PER_HOUR) {
      throw new HttpException(
        {
          statusCode: 429,
          error: 'Too Many Requests',
          message: 'Too many plan previews for this business. Try again later.',
        },
        429,
      );
    }

    // The provider's live view (read before any write; nothing changes).
    let snapshot: ProviderSubscriptionSnapshot;
    let toExternalPriceId: string;
    let charge: ProviderChargePreview | null = null;
    let recurringTotal: number;
    const prorationDate = new Date(Math.floor(now.getTime() / 1000) * 1000);
    try {
      snapshot = await this.provider.retrieveSubscription(
        subscription.externalSubscriptionId,
      );
      if (
        snapshot.externalSubscriptionId !==
          subscription.externalSubscriptionId ||
        snapshot.externalCustomerId !== subscription.externalCustomerId ||
        snapshot.livemode !== this.provider.livemode ||
        snapshot.status !==
          (subscription.status === 'TRIALING' ? 'trialing' : 'active') ||
        snapshot.cancelAtPeriodEnd
      ) {
        throw notChangeable();
      }
      const billed = verifyBilledPrice(snapshot, current.externalPriceId);
      if (!billed.ok) {
        if (
          billed.problem === 'SCHEDULE_ATTACHED' ||
          billed.problem === 'PENDING_UPDATE'
        ) {
          throw conflict(
            BILLING_PLAN_CHANGE_IN_PROGRESS,
            'A plan change is already in progress for this business.',
          );
        }
        await runSerializable(this.prisma, (tx) =>
          this.lifecycle.openCase(
            tx,
            PRICE_MISMATCH_CASE,
            subscription.id,
            null,
            `Plan change preview refused: the provider subscription does not bill our recorded price (${billed.problem}). Nothing was changed.`,
          ),
        );
        throw conflict(
          BILLING_PLAN_CHANGE_UNVERIFIED,
          "We couldn't confirm this subscription's current price with the payment provider. Our team has been notified; nothing was changed.",
        );
      }
      toExternalPriceId = await syncProviderPrice(
        this.prisma,
        this.provider,
        target.plan,
        target,
      );
      const itemInput = {
        externalSubscriptionId: subscription.externalSubscriptionId,
        externalItemId: billed.item.externalItemId,
        toExternalPriceId,
      };
      if (timing === 'IMMEDIATE') {
        charge = await this.provider.previewImmediateChange({
          ...itemInput,
          prorationDate,
        });
        this.assertPreview(charge, target.currency);
      }
      const recurring = await this.provider.previewRecurring(itemInput);
      this.assertPreview(recurring, target.currency);
      recurringTotal = Math.max(0, recurring.totalMinorUnits);

      const expiresAt = new Date(now.getTime() + PLAN_CHANGE_PREVIEW_TTL_MS);
      const startsAt = nextRecurringStart(
        timing,
        current.interval,
        target.interval,
        snapshot,
      );
      const row = await runSerializable(this.prisma, async (tx) => {
        const created = await tx.billingPlanChange.create({
          data: {
            subscriptionId: subscription.id,
            timing,
            fromPlanVersionId: subscription.planVersionId,
            fromPlanPriceId: current.id,
            toPlanVersionId: targetVersion.id,
            toPlanPriceId: target.id,
            currency: target.currency.toUpperCase(),
            previewAmountDueMinorUnits: charge?.amountDueMinorUnits ?? null,
            previewTotalMinorUnits: charge?.totalMinorUnits ?? null,
            previewTaxMinorUnits: charge?.taxMinorUnits ?? null,
            previewDiscountMinorUnits: charge?.discountMinorUnits ?? null,
            previewProrationMinorUnits: charge?.prorationMinorUnits ?? null,
            prorationDate: timing === 'IMMEDIATE' ? prorationDate : null,
            externalItemId:
              timing === 'IMMEDIATE' ? billed.item.externalItemId : null,
            nextRecurringMinorUnits: recurringTotal,
            nextRecurringStartsAt: startsAt,
            previewExpiresAt: expiresAt,
            actorKind: actor.kind,
            actorPlatformOperatorId:
              actor.kind === 'OPERATOR' ? actor.platformOperatorId : null,
            createdAt: now,
          },
          select: { id: true },
        });
        if (actor.kind === 'STAFF') {
          await this.audit.recordPlanChangePreviewed(tx, {
            actorInternalUserId: actor.internalUserId,
            subscriptionId: subscription.id,
            planChangeId: created.id,
            toPlanPriceId: target.id,
            timing,
          });
        } else {
          await tx.platformAuditEvent.create({
            data: {
              action: PLATFORM_AUDIT_ACTIONS.billingPlanChangePreviewed,
              outcome: 'SUCCEEDED',
              reasonCode: timing,
              actorPlatformOperatorId: actor.platformOperatorId,
              targetType: 'tenant',
              targetId: tenantId,
              requestReference: actor.requestReference,
            },
          });
        }
        return created;
      });

      return {
        previewId: row.id,
        timing,
        current: side(subscription.planVersion.plan.name, current),
        target: side(target.plan.name, target),
        chargeNow: charge
          ? {
              amountDueMinorUnits: charge.amountDueMinorUnits,
              totalMinorUnits: charge.totalMinorUnits,
              taxMinorUnits: charge.taxMinorUnits,
              discountMinorUnits: charge.discountMinorUnits,
              prorationMinorUnits: charge.prorationMinorUnits,
              currency: target.currency.toUpperCase(),
            }
          : null,
        nextRecurring: {
          amountMinorUnits: recurringTotal,
          currency: target.currency.toUpperCase(),
          interval: target.interval,
          startsAt: startsAt?.toISOString() ?? null,
        },
        expiresAt: expiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }
  }

  // The provider's answer must be test mode (the configured mode) and in the
  // subscription's currency — otherwise it is not shown.
  private assertPreview(
    preview: { livemode: boolean; currency: string },
    currency: string,
  ): void {
    if (
      preview.livemode !== this.provider.livemode ||
      preview.currency.toLowerCase() !== currency.toLowerCase()
    ) {
      throw new SaasBillingProviderError('preview_mismatch');
    }
  }
}

function side(
  planName: string,
  price: {
    amountMinorUnits: number;
    currency: string;
    interval: 'MONTH' | 'YEAR';
  },
) {
  return {
    planName,
    price: {
      amountMinorUnits: price.amountMinorUnits,
      currency: price.currency.toUpperCase(),
      interval: price.interval,
    },
  };
}

// When the new recurring price starts: an immediate same-interval change
// keeps the renewal date; monthly -> annual starts a new period now (null);
// a period-end change starts at the period end; a trial choice at the trial
// end.
function nextRecurringStart(
  timing: PlanChangeTiming,
  fromInterval: 'MONTH' | 'YEAR',
  toInterval: 'MONTH' | 'YEAR',
  snapshot: ProviderSubscriptionSnapshot,
): Date | null {
  if (timing === 'TRIAL_END') return snapshot.trialEnd;
  if (timing === 'IMMEDIATE' && fromInterval !== toInterval) return null;
  return snapshot.currentPeriodEnd ?? null;
}
