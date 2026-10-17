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
  BILLING_PLAN_CHANGE_PREVIEW_CHANGED,
  BILLING_PLAN_CHANGE_PREVIEW_EXPIRED,
  BILLING_PLAN_CHANGE_NOT_PAYABLE,
  BILLING_UNAVAILABLE,
  type AdminPlanChangeStatus,
  type AdminPlanChangeView,
  type AdminPlanOption,
  type BillingPlanChangePreview,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializable } from '../../prisma/serializable-transaction';
import { InternalAuditService } from '../../audit/internal-audit.service';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import { isUuid } from '../../platform-subscriptions/application/plan-input';
import {
  PLAN_CHANGE_PREVIEW_TTL_MS,
  planChangeIdempotencyKey,
  planChangeTiming,
  verifyBilledPrice,
  type PlanChangeTiming,
} from '../domain/plan-change';
import type { ProviderSubscriptionSnapshot } from '../domain/provider-sync';
import {
  SAAS_BILLING_PROVIDER,
  SaasBillingProviderError,
  type ProviderChargePreview,
  type ProviderInvoice,
  type ProviderPayableInvoice,
  type ProviderPriceChangeResult,
  type SaasBillingProvider,
} from '../provider/saas-billing-provider';
import {
  BillingLifecycleService,
  PLAN_CHANGE_UNCERTAIN_CASE,
} from './billing-lifecycle.service';
import { isProviderPage } from './billing-account.service';
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
      // SC3d-2 — mandatory (10–500 characters).
      reason: string;
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

// SC3d-2 — an operator's preview: body exactly { planPriceId, reason }.
export function parseOperatorPlanChangePreview(body: unknown): {
  planPriceId: string;
  reason: string;
} {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).sort().join(',') !== 'planPriceId,reason'
  ) {
    throw new BadRequestException(
      'Choose one price (planPriceId) and give a reason.',
    );
  }
  const { planPriceId, reason } = body as {
    planPriceId: unknown;
    reason: unknown;
  };
  if (typeof planPriceId !== 'string' || !isUuid(planPriceId)) {
    throw new BadRequestException('Choose one price (planPriceId).');
  }
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < 10 || text.length > 500 || hasControlCharacter(text)) {
    throw new BadRequestException('Give a reason of 10 to 500 characters.');
  }
  return { planPriceId, reason: text };
}

export function parsePlanChangeConfirm(body: unknown): string {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).join(',') !== 'previewId'
  ) {
    throw new BadRequestException('Confirm one preview (previewId).');
  }
  const value = (body as { previewId: unknown }).previewId;
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new BadRequestException('Confirm one preview (previewId).');
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if ((code < 0x20 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

const previewExpired = () =>
  conflict(
    BILLING_PLAN_CHANGE_PREVIEW_EXPIRED,
    'This price preview has expired. Preview the change again to see the current price.',
  );
const previewChanged = () =>
  conflict(
    BILLING_PLAN_CHANGE_PREVIEW_CHANGED,
    'The price for this change is no longer the one you were shown. Preview it again and confirm the new price.',
  );

// What the business is told about a change (never "applied" before the
// provider's payment AND price are verified).
function viewStatus(status: string): AdminPlanChangeStatus {
  switch (status) {
    case 'REQUESTED':
      return 'PROCESSING';
    case 'AWAITING_PAYMENT':
      return 'PAYMENT_NEEDED';
    case 'APPLIED':
      return 'APPLIED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'FAILED':
    case 'CANCELED':
      return 'FAILED';
    default:
      return 'REVIEW';
  }
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
            operatorReason: actor.kind === 'OPERATOR' ? actor.reason : null,
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

  // --- SC3d-2: confirmation -------------------------------------------------------

  // The business's OWN confirmation of the preview it was shown — the only
  // way a plan change is charged. Everything is re-checked first; the charge
  // must be EXACTLY the previewed one (minor units), or a new preview is
  // needed. Then: one open change (database-enforced), the provider's
  // "apply only if paid" update with this change's idempotency key, and the
  // result settled against the provider (new features only once paid AND
  // the new price is verified).
  async confirm(
    tenantId: string,
    previewId: string,
    actorInternalUserId: string,
    now: Date = new Date(),
  ): Promise<AdminPlanChangeView> {
    if (!isUuid(tenantId)) throw new NotFoundException('Business not found.');
    const change = await this.prisma.billingPlanChange.findFirst({
      where: { id: previewId, subscription: { subscriberTenantId: tenantId } },
      include: { toPlanPrice: { include: { plan: true } } },
    });
    if (!change) throw new NotFoundException('Preview not found.');
    if (change.status !== 'PREVIEWED' || change.previewExpiresAt <= now) {
      throw previewExpired();
    }
    if (change.timing !== 'IMMEDIATE') {
      // SC3d-3 — period-end changes and trial plan choices.
      throw conflict(
        BILLING_PLAN_CHANGE_UNAVAILABLE,
        "This change can't be confirmed yet: changes at the end of the billing period are not available.",
      );
    }
    const subscription = await this.prisma.tenantSubscription.findUniqueOrThrow(
      {
        where: { id: change.subscriptionId },
        include: SUBSCRIPTION_INCLUDE,
      },
    );
    const current = subscription.planPrice;
    const target = change.toPlanPrice;
    if (
      subscription.billingMode !== 'BILLED' ||
      subscription.externalSubscriptionId === null ||
      current === null ||
      subscription.status !== 'ACTIVE' ||
      subscription.subscriberTenant.status !== 'ACTIVE' ||
      subscription.cancelAtPeriodEnd ||
      subscription.pendingChangeKind !== null
    ) {
      throw notChangeable();
    }
    if (
      subscription.billingProvider !== this.provider.name ||
      !this.provider.available
    ) {
      throw unavailable();
    }
    // Still for the plan and price the business is on, to a price still
    // offered, of the plan version still offered.
    const latestVersion = await this.prisma.subscriptionPlanVersion.findFirst({
      where: { planId: target.planId, status: 'PUBLISHED' },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    if (
      current.id !== change.fromPlanPriceId ||
      subscription.planVersionId !== change.fromPlanVersionId ||
      target.status !== 'ACTIVE' ||
      target.externalPriceId === null ||
      latestVersion?.id !== change.toPlanVersionId ||
      target.currency.toUpperCase() !== change.currency
    ) {
      throw previewExpired();
    }
    const open = await this.prisma.billingPlanChange.count({
      where: {
        subscriptionId: subscription.id,
        status: {
          in: ['REQUESTED', 'AWAITING_PAYMENT', 'SCHEDULED', 'REVIEW'],
        },
      },
    });
    if (open > 0) {
      throw conflict(
        BILLING_PLAN_CHANGE_IN_PROGRESS,
        'A plan change is already in progress for this business.',
      );
    }

    // The provider, live: the same subscription, billing exactly the price
    // we record, on the previewed item, with nothing pending — and the SAME
    // charge at the SAME proration date.
    try {
      const snapshot = await this.provider.retrieveSubscription(
        subscription.externalSubscriptionId,
      );
      if (
        snapshot.externalSubscriptionId !==
          subscription.externalSubscriptionId ||
        snapshot.externalCustomerId !== subscription.externalCustomerId ||
        snapshot.livemode !== this.provider.livemode ||
        snapshot.status !== 'active' ||
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
        throw conflict(
          BILLING_PLAN_CHANGE_UNVERIFIED,
          "We couldn't confirm this subscription's current price with the payment provider. Nothing was changed.",
        );
      }
      if (billed.item.externalItemId !== change.externalItemId)
        throw previewExpired();
      const again = await this.provider.previewImmediateChange({
        externalSubscriptionId: subscription.externalSubscriptionId,
        externalItemId: change.externalItemId,
        toExternalPriceId: target.externalPriceId,
        prorationDate: change.prorationDate!,
      });
      if (
        again.livemode !== this.provider.livemode ||
        again.currency.toUpperCase() !== change.currency ||
        again.amountDueMinorUnits !== change.previewAmountDueMinorUnits ||
        again.totalMinorUnits !== change.previewTotalMinorUnits ||
        again.taxMinorUnits !== change.previewTaxMinorUnits ||
        again.discountMinorUnits !== change.previewDiscountMinorUnits ||
        again.prorationMinorUnits !== change.previewProrationMinorUnits
      ) {
        throw previewChanged();
      }
    } catch (error) {
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }

    // The one open change (the partial unique index refuses a second), the
    // business's consent recorded and audited — before anything is sent.
    try {
      await runSerializable(this.prisma, async (tx) => {
        const fresh = await tx.tenantSubscription.findUniqueOrThrow({
          where: { id: subscription.id },
          select: { billingStateVersion: true },
        });
        if (fresh.billingStateVersion !== subscription.billingStateVersion) {
          throw previewChanged();
        }
        const { count } = await tx.billingPlanChange.updateMany({
          where: { id: change.id, status: 'PREVIEWED' },
          data: { status: 'REQUESTED', confirmedAt: now },
        });
        if (count !== 1) throw previewExpired();
        await this.audit.recordPlanChangeConfirmed(tx, {
          actorInternalUserId,
          subscriptionId: subscription.id,
          planChangeId: change.id,
          toPlanPriceId: target.id,
          amountDueMinorUnits: change.previewAmountDueMinorUnits!,
          currency: change.currency,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          BILLING_PLAN_CHANGE_IN_PROGRESS,
          'A plan change is already in progress for this business.',
        );
      }
      throw error;
    }

    await this.submit(change.id);
    return this.view(change.id);
  }

  // Sends a REQUESTED change to the provider (its own idempotency key, the
  // confirmed parameters) and records + settles the result. A provider error
  // leaves it REQUESTED: the maintenance sweep retries the SAME request.
  async submit(planChangeId: string): Promise<void> {
    const change = await this.prisma.billingPlanChange.findUniqueOrThrow({
      where: { id: planChangeId },
      include: {
        toPlanPrice: { select: { externalPriceId: true } },
        subscription: { select: { externalSubscriptionId: true } },
      },
    });
    if (
      change.status !== 'REQUESTED' ||
      change.externalInvoiceId !== null ||
      change.externalItemId === null ||
      change.prorationDate === null ||
      change.toPlanPrice.externalPriceId === null ||
      change.subscription.externalSubscriptionId === null
    ) {
      return;
    }
    let result: ProviderPriceChangeResult;
    let invoice: ProviderInvoice | null = null;
    try {
      result = await this.provider.changePriceNow({
        idempotencyKey: planChangeIdempotencyKey(change.id, 'change-now'),
        externalSubscriptionId: change.subscription.externalSubscriptionId,
        externalItemId: change.externalItemId,
        toExternalPriceId: change.toPlanPrice.externalPriceId,
        prorationDate: change.prorationDate,
      });
      if (result.externalInvoiceId !== null) {
        invoice = await this.provider.retrieveInvoice(result.externalInvoiceId);
      }
    } catch (error) {
      if (error instanceof SaasBillingProviderError) return;
      throw error;
    }
    if (
      result.externalInvoiceId === null ||
      invoice === null ||
      invoice.billingReason !== 'subscription_update'
    ) {
      await runSerializable(this.prisma, (tx) =>
        this.lifecycle.markPlanChangeReview(
          tx,
          change.id,
          PLAN_CHANGE_UNCERTAIN_CASE,
          `Plan change ${change.id}: the provider answered without its plan change invoice (${result.externalInvoiceId ?? 'none'}). Nothing was applied here.`,
        ),
      );
      return;
    }
    await runSerializable(this.prisma, (tx) =>
      this.lifecycle.recordPlanChangeSubmitted(
        tx,
        change.id,
        result.externalInvoiceId!,
        result.snapshot,
        invoice,
        {
          source: 'SYSTEM',
          billingProviderEventId: null,
          actorPlatformOperatorId: null,
        },
      ),
    );
  }

  // A REQUESTED change whose submission was interrupted, shortly after the
  // business confirmed it: re-sent ONLY as the same operation (same key and
  // parameters) and only when that is still exactly what the business
  // confirmed. If the provider already holds it (a pending update or the new
  // price), the replay returns that same result. If the provider shows
  // nothing yet, the charge is re-checked at the confirmed proration date and
  // must still equal the preview; otherwise nothing is sent and the change
  // ends (nothing was charged) — the business previews again.
  async resubmitChecked(planChangeId: string): Promise<void> {
    const change = await this.prisma.billingPlanChange.findUniqueOrThrow({
      where: { id: planChangeId },
      include: {
        subscription: true,
        fromPlanPrice: { select: { externalPriceId: true } },
        toPlanPrice: { select: { externalPriceId: true } },
      },
    });
    const externalSubscriptionId = change.subscription.externalSubscriptionId;
    if (
      change.status !== 'REQUESTED' ||
      change.externalInvoiceId !== null ||
      externalSubscriptionId === null ||
      change.externalItemId === null ||
      change.prorationDate === null ||
      change.toPlanPrice.externalPriceId === null
    ) {
      return;
    }
    try {
      const snapshot = await this.provider.retrieveSubscription(
        externalSubscriptionId,
      );
      const item = snapshot.items?.length === 1 ? snapshot.items[0] : null;
      const landed =
        snapshot.hasPendingUpdate === true ||
        item?.externalPriceId === change.toPlanPrice.externalPriceId;
      if (!landed) {
        const unchanged =
          item !== null &&
          item.externalItemId === change.externalItemId &&
          item.externalPriceId === change.fromPlanPrice.externalPriceId &&
          snapshot.scheduleId === null &&
          snapshot.status === 'active';
        const again = unchanged
          ? await this.provider.previewImmediateChange({
              externalSubscriptionId,
              externalItemId: change.externalItemId,
              toExternalPriceId: change.toPlanPrice.externalPriceId,
              prorationDate: change.prorationDate,
            })
          : null;
        if (
          again === null ||
          again.livemode !== this.provider.livemode ||
          again.currency.toUpperCase() !== change.currency ||
          again.amountDueMinorUnits !== change.previewAmountDueMinorUnits ||
          again.totalMinorUnits !== change.previewTotalMinorUnits ||
          again.taxMinorUnits !== change.previewTaxMinorUnits ||
          again.discountMinorUnits !== change.previewDiscountMinorUnits ||
          again.prorationMinorUnits !== change.previewProrationMinorUnits
        ) {
          await this.prisma.billingPlanChange.updateMany({
            where: {
              id: change.id,
              status: 'REQUESTED',
              externalInvoiceId: null,
            },
            data: {
              status: 'FAILED',
              failureCode: 'PREVIEW_CHANGED',
              finishedAt: new Date(),
            },
          });
          return;
        }
      }
    } catch (error) {
      // The provider could not be read: left for the next sweep (and, past
      // the replay window, only inspected).
      if (error instanceof SaasBillingProviderError) return;
      throw error;
    }
    await this.submit(change.id);
  }

  // The provider's hosted page for the WAITING change's own invoice — found
  // through OUR records, checked to be ours and open, on the provider's host.
  async payLink(
    tenantId: string,
    actorInternalUserId: string,
  ): Promise<{ url: string }> {
    if (!isUuid(tenantId)) throw new NotFoundException('Business not found.');
    const change = await this.prisma.billingPlanChange.findFirst({
      where: {
        status: 'AWAITING_PAYMENT',
        externalInvoiceId: { not: null },
        subscription: { subscriberTenantId: tenantId },
      },
      include: { subscription: true },
    });
    const notPayable = () =>
      conflict(
        BILLING_PLAN_CHANGE_NOT_PAYABLE,
        'There is no plan change payment to complete.',
      );
    if (!change || change.subscription.externalSubscriptionId === null)
      throw notPayable();
    let open: ProviderPayableInvoice[];
    try {
      open = await this.provider.listOpenInvoices(
        change.subscription.externalSubscriptionId,
      );
    } catch (error) {
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }
    const invoice = open.find(
      (candidate) => candidate.externalInvoiceId === change.externalInvoiceId,
    );
    if (
      !invoice ||
      invoice.status !== 'open' ||
      invoice.livemode !== this.provider.livemode ||
      invoice.externalSubscriptionId !==
        change.subscription.externalSubscriptionId ||
      (invoice.externalCustomerId !== null &&
        invoice.externalCustomerId !==
          change.subscription.externalCustomerId) ||
      !invoice.hostedInvoiceUrl ||
      !isProviderPage(invoice.hostedInvoiceUrl, this.provider.name, 'invoice')
    ) {
      throw notPayable();
    }
    await runSerializable(this.prisma, (tx) =>
      this.audit.recordBillingRecoveryStarted(tx, {
        actorInternalUserId,
        subscriptionId: change.subscriptionId,
        kind: 'PLAN_CHANGE_PAYMENT',
        reference: invoice.externalInvoiceId,
      }),
    );
    return { url: invoice.hostedInvoiceUrl };
  }

  // The business's latest confirmed change worth showing: an open one, or
  // one that finished in the last 7 days.
  async latest(
    tenantId: string,
    now: Date = new Date(),
  ): Promise<AdminPlanChangeView | null> {
    const change = await this.prisma.billingPlanChange.findFirst({
      where: {
        subscription: { subscriberTenantId: tenantId },
        confirmedAt: { not: null },
        OR: [
          { finishedAt: null },
          {
            finishedAt: {
              gt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
            },
          },
        ],
      },
      orderBy: { confirmedAt: 'desc' },
      select: { id: true },
    });
    return change ? this.view(change.id) : null;
  }

  async view(planChangeId: string): Promise<AdminPlanChangeView> {
    const change = await this.prisma.billingPlanChange.findUniqueOrThrow({
      where: { id: planChangeId },
      include: { toPlanPrice: { include: { plan: true } } },
    });
    return {
      id: change.id,
      status: viewStatus(change.status),
      target: side(change.toPlanPrice.plan.name, change.toPlanPrice),
      amountDueMinorUnits: change.previewAmountDueMinorUnits,
      currency: change.currency,
      confirmedAt: change.confirmedAt?.toISOString() ?? null,
      finishedAt: change.finishedAt?.toISOString() ?? null,
    };
  }

  // Whether the business may start a change now (ACTIVE billed, not
  // Founding, no change open or pending).
  async canChange(tenantId: string): Promise<boolean> {
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { subscriberTenantId: tenantId },
      include: SUBSCRIPTION_INCLUDE,
    });
    if (
      !subscription ||
      subscription.billingMode !== 'BILLED' ||
      subscription.externalSubscriptionId === null ||
      subscription.planPrice === null ||
      subscription.status !== 'ACTIVE' ||
      subscription.subscriberTenant.status !== 'ACTIVE' ||
      subscription.cancelAtPeriodEnd ||
      subscription.pendingChangeKind !== null ||
      subscription.planVersion.plan.key === 'founding'
    ) {
      return false;
    }
    const open = await this.prisma.billingPlanChange.count({
      where: {
        subscriptionId: subscription.id,
        status: {
          in: ['REQUESTED', 'AWAITING_PAYMENT', 'SCHEDULED', 'REVIEW'],
        },
      },
    });
    return open === 0;
  }

  // The prices the business may move to: ACTIVE prices of offered plans (a
  // published version; never Founding), in the subscription's currency.
  async options(tenantId: string): Promise<AdminPlanOption[]> {
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { subscriberTenantId: tenantId },
      include: SUBSCRIPTION_INCLUDE,
    });
    if (
      !subscription ||
      subscription.billingMode !== 'BILLED' ||
      subscription.planPrice === null
    ) {
      return [];
    }
    const prices = await this.prisma.subscriptionPlanPrice.findMany({
      where: {
        status: 'ACTIVE',
        currency: subscription.planPrice.currency,
        plan: {
          key: { not: 'founding' },
          versions: { some: { status: 'PUBLISHED' } },
        },
      },
      include: { plan: true },
      orderBy: [{ amountMinorUnits: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    return prices.map((price) => ({
      planPriceId: price.id,
      planName: price.plan.name,
      amountMinorUnits: price.amountMinorUnits,
      currency: price.currency.toUpperCase(),
      interval: price.interval,
      current: price.id === subscription.planPriceId,
    }));
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
