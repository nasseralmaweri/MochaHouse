import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializable } from '../../prisma/serializable-transaction';
import {
  transition,
  type BillingEvent,
  type BillingHistoryEntry,
  type BillingState,
  type RefusalReason,
  type SuspensionEffect,
} from '../domain/billing-lifecycle';
import {
  SAAS_BILLING_PROVIDER,
  type ProviderLifecycleEvent,
  type SaasBillingProvider,
  type VerifiedBillingProviderEvent,
} from '../provider/saas-billing-provider';

// SC3a — applies billing lifecycle changes to a business's subscription
// (the SC2a TenantSubscription — no parallel model).
//
// Provider events are delivered at least once, possibly late and out of
// order. Each one is RECORDED first (BillingProviderEvent, unique per
// provider event id — a redelivery finds the record and changes nothing),
// then APPLIED in one serializable transaction that writes the new
// subscription state (compare-and-set), its history and the event's
// outcome together, so an effect can never apply twice. The business is
// found ONLY through our stored provider ids; a business id carried in the
// event's metadata is cross-checked and a mismatch rejects the event. An
// event older than the newest one already applied to that subscription is
// ignored (it can never roll the state back).
//
// The suspension effect (E6) is returned, not executed: enforcing it on the
// business is SC3c, through decideSuspension (never overriding a SECURITY or
// administrative suspension).

export const DEFAULT_BILLING_POLICY_ID = 'default';

export type BillingEventOutcome =
  | {
      status: 'APPLIED';
      duplicate: false;
      subscriptionId: string;
      suspension: SuspensionEffect;
      outcome: string;
    }
  | {
      status: 'IGNORED' | 'REJECTED' | 'FAILED';
      duplicate: boolean;
      subscriptionId: string | null;
      outcome: string;
    }
  | {
      // Already final before this delivery.
      status: 'APPLIED' | 'IGNORED' | 'REJECTED';
      duplicate: true;
      subscriptionId: string | null;
      outcome: string;
    };

export class BillingLifecycleError extends Error {
  constructor(
    readonly reason:
      | RefusalReason
      | 'NOT_FOUND'
      | 'TRIALS_DISABLED'
      | 'TRIALS_UNAVAILABLE'
      | 'CONCURRENT_CHANGE',
  ) {
    super(`Billing change refused: ${reason}.`);
    this.name = 'BillingLifecycleError';
  }
}

type Tx = Prisma.TransactionClient;

class ConcurrentBillingChange extends Error {}

type SubscriptionRow = Prisma.TenantSubscriptionGetPayload<
  Record<string, never>
>;

export function toBillingState(row: SubscriptionRow): BillingState {
  return {
    billingMode: row.billingMode,
    status: row.status,
    planVersionId: row.planVersionId,
    planPriceId: row.planPriceId,
    recurringPaymentAuthorizedAt: row.recurringPaymentAuthorizedAt,
    trialStartedAt: row.trialStartedAt,
    trialEndsAt: row.trialEndsAt,
    trialRequiresPaymentMethod: row.trialRequiresPaymentMethod,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    pastDueAt: row.pastDueAt,
    graceEndsAt: row.graceEndsAt,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    canceledAt: row.canceledAt,
    pending:
      row.pendingChangeKind && row.pendingPlanVersionId
        ? {
            kind: row.pendingChangeKind,
            planVersionId: row.pendingPlanVersionId,
            planPriceId: row.pendingPlanPriceId,
            reference: row.pendingChangeReference,
            effectiveAt: row.pendingEffectiveAt,
          }
        : null,
  };
}

function stateColumns(next: BillingState) {
  return {
    status: next.status,
    planVersionId: next.planVersionId,
    planPriceId: next.planPriceId,
    recurringPaymentAuthorizedAt: next.recurringPaymentAuthorizedAt,
    trialStartedAt: next.trialStartedAt,
    trialEndsAt: next.trialEndsAt,
    trialRequiresPaymentMethod: next.trialRequiresPaymentMethod,
    currentPeriodStart: next.currentPeriodStart,
    currentPeriodEnd: next.currentPeriodEnd,
    pastDueAt: next.pastDueAt,
    graceEndsAt: next.graceEndsAt,
    cancelAtPeriodEnd: next.cancelAtPeriodEnd,
    canceledAt: next.canceledAt,
    pendingChangeKind: next.pending?.kind ?? null,
    pendingPlanVersionId: next.pending?.planVersionId ?? null,
    pendingPlanPriceId: next.pending?.planPriceId ?? null,
    pendingChangeReference: next.pending?.reference ?? null,
    pendingEffectiveAt: next.pending?.effectiveAt ?? null,
  };
}

// A keyed digest (HMAC-SHA256 with a server secret) of the normalized owner
// email: one trial per email across businesses, without storing the address
// or a digest that could be reversed by guessing addresses.
export const TRIAL_CLAIM_SECRET_ENV = 'SAAS_BILLING_TRIAL_CLAIM_SECRET';

export function trialClaimKey(ownerEmail: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(ownerEmail.trim().toLowerCase())
    .digest('hex');
}

function trialClaimSecret(): string {
  const secret = process.env[TRIAL_CLAIM_SECRET_ENV];
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new BillingLifecycleError('TRIALS_UNAVAILABLE');
  }
  return secret;
}

// Refusals that can only be due to the order in which events arrived (a
// later delivery may succeed): kept retryable (FAILED), never final.
const PERMANENT_REFUSALS = new Set<RefusalReason>([
  'COMPLIMENTARY',
  'CANCELED',
]);

// How far ahead of our clock an event may claim to have happened.
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

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

// What is stored about a failure: a short code, never raw error text.
function failureCode(error: unknown): string {
  if (error instanceof BillingLifecycleError) return error.reason;
  if (error instanceof ConcurrentBillingChange) return 'CONCURRENT_CHANGE';
  return 'APPLY_ERROR';
}

@Injectable()
export class BillingLifecycleService {
  private readonly logger = new Logger(BillingLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SAAS_BILLING_PROVIDER)
    private readonly provider: SaasBillingProvider,
  ) {}

  // --- provider events -------------------------------------------------------

  async recordAndApply(
    verified: VerifiedBillingProviderEvent,
  ): Promise<BillingEventOutcome> {
    const ledger = await this.record(verified);
    if (ledger.payloadDigest !== verified.payloadDigest) {
      // The same provider event id with different content: never applied.
      this.logger.warn(
        `Billing event ${ledger.id} redelivered with a different payload; not applied.`,
      );
      return {
        status: 'REJECTED',
        duplicate: true,
        subscriptionId: ledger.subscriptionId,
        outcome: 'PAYLOAD_MISMATCH',
      };
    }
    if (
      ledger.status === 'APPLIED' ||
      ledger.status === 'IGNORED' ||
      ledger.status === 'REJECTED'
    ) {
      return {
        status: ledger.status,
        duplicate: true,
        subscriptionId: ledger.subscriptionId,
        outcome: ledger.outcome ?? '',
      };
    }
    try {
      return await runSerializable(this.prisma, (tx) =>
        this.apply(tx, ledger.id, verified),
      );
    } catch (error) {
      // Recorded as FAILED (retryable by redelivery); never half-applied —
      // the transaction rolled back.
      const outcome = failureCode(error);
      // Conditional: a concurrent delivery may already have applied it.
      await this.prisma.billingProviderEvent.updateMany({
        where: { id: ledger.id, status: { in: ['RECEIVED', 'FAILED'] } },
        data: {
          status: 'FAILED',
          outcome,
          processedAt: new Date(),
          attempts: { increment: 1 },
        },
      });
      this.logger.error(
        `Billing event ${ledger.id} failed to apply (${outcome}): ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
      return {
        status: 'FAILED',
        duplicate: false,
        subscriptionId: null,
        outcome,
      };
    }
  }

  private async record(verified: VerifiedBillingProviderEvent) {
    const where = {
      provider_externalEventId: {
        provider: verified.provider,
        externalEventId: verified.externalEventId,
      },
    };
    const existing = await this.prisma.billingProviderEvent.findUnique({
      where,
    });
    if (existing) return existing;
    try {
      return await this.prisma.billingProviderEvent.create({
        data: {
          provider: verified.provider,
          externalEventId: verified.externalEventId,
          type: verified.providerType,
          livemode: verified.livemode,
          occurredAt: verified.occurredAt,
          payloadDigest: verified.payloadDigest,
          externalSubscriptionId: verified.externalSubscriptionId,
          externalCustomerId: verified.externalCustomerId,
        },
      });
    } catch (error) {
      // A concurrent delivery of the same event recorded it first.
      if (isUniqueViolation(error)) {
        return this.prisma.billingProviderEvent.findUniqueOrThrow({ where });
      }
      throw error;
    }
  }

  private async apply(
    tx: Tx,
    ledgerId: string,
    verified: VerifiedBillingProviderEvent,
  ): Promise<BillingEventOutcome> {
    const ledger = await tx.billingProviderEvent.findUniqueOrThrow({
      where: { id: ledgerId },
    });
    if (
      ledger.status === 'APPLIED' ||
      ledger.status === 'IGNORED' ||
      ledger.status === 'REJECTED'
    ) {
      return {
        status: ledger.status,
        duplicate: true,
        subscriptionId: ledger.subscriptionId,
        outcome: ledger.outcome ?? '',
      };
    }

    // FAILED = not applied, retryable (a later delivery is applied).
    const finish = async (
      status: 'IGNORED' | 'REJECTED' | 'FAILED',
      outcome: string,
      subscriptionId: string | null,
    ): Promise<BillingEventOutcome> => {
      await tx.billingProviderEvent.update({
        where: { id: ledgerId },
        data: {
          status,
          outcome,
          subscriptionId,
          processedAt: new Date(),
          attempts: { increment: 1 },
        },
      });
      return { status, duplicate: false, subscriptionId, outcome };
    };

    // Test-mode events never act on a live setup and vice versa.
    if (verified.livemode !== this.provider.livemode) {
      return finish('REJECTED', 'LIVEMODE_MISMATCH', null);
    }
    if (verified.occurredAt.getTime() > Date.now() + MAX_FUTURE_SKEW_MS) {
      return finish('REJECTED', 'FUTURE_EVENT', null);
    }
    if (verified.event.kind === 'UNSUPPORTED') {
      return finish('IGNORED', 'UNSUPPORTED_TYPE', null);
    }
    if (verified.externalSubscriptionId === null) {
      return finish('IGNORED', 'NO_SUBSCRIPTION_REFERENCE', null);
    }
    // The ONLY way an event reaches a business: our stored provider ids.
    const subscription = await tx.tenantSubscription.findUnique({
      where: {
        billingProvider_externalSubscriptionId: {
          billingProvider: verified.provider,
          externalSubscriptionId: verified.externalSubscriptionId,
        },
      },
    });
    if (!subscription) {
      // Possibly delivered before we stored the provider ids: retryable.
      return finish('FAILED', 'NO_MATCHING_SUBSCRIPTION', null);
    }
    if (
      verified.externalCustomerId !== null &&
      subscription.externalCustomerId !== verified.externalCustomerId
    ) {
      return finish('REJECTED', 'CUSTOMER_MISMATCH', subscription.id);
    }
    if (
      verified.claimedTenantId !== null &&
      verified.claimedTenantId !== subscription.subscriberTenantId
    ) {
      return finish('REJECTED', 'TENANT_CLAIM_MISMATCH', subscription.id);
    }
    // An older event never rolls the state back — except an authorization,
    // a fact that only ever adds (it never removes access or charges).
    if (
      verified.event.kind !== 'PAYMENT_AUTHORIZED' &&
      subscription.lastBillingEventAt !== null &&
      verified.occurredAt < subscription.lastBillingEventAt
    ) {
      return finish('IGNORED', 'STALE', subscription.id);
    }

    const event = await this.lifecycleEvent(tx, verified, verified.event);
    const result = transition(toBillingState(subscription), event);
    if (!result.ok) {
      return finish(
        PERMANENT_REFUSALS.has(result.reason) ? 'REJECTED' : 'FAILED',
        result.reason,
        subscription.id,
      );
    }
    if (!result.changed) {
      return finish('IGNORED', 'NO_CHANGE', subscription.id);
    }

    const lastBillingEventAt =
      subscription.lastBillingEventAt !== null &&
      subscription.lastBillingEventAt > verified.occurredAt
        ? subscription.lastBillingEventAt
        : verified.occurredAt;
    await this.write(tx, subscription, result.next, lastBillingEventAt);
    await this.history(tx, subscription.id, result.history, {
      source: 'BILLING_PROVIDER',
      billingProviderEventId: ledgerId,
      actorPlatformOperatorId: null,
    });
    const outcome = `${subscription.status}->${result.next.status}`;
    await tx.billingProviderEvent.update({
      where: { id: ledgerId },
      data: {
        status: 'APPLIED',
        outcome,
        subscriptionId: subscription.id,
        processedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    return {
      status: 'APPLIED',
      duplicate: false,
      subscriptionId: subscription.id,
      suspension: result.suspension,
      outcome,
    };
  }

  private async lifecycleEvent(
    tx: Tx,
    verified: VerifiedBillingProviderEvent,
    event: Exclude<ProviderLifecycleEvent, { kind: 'UNSUPPORTED' }>,
  ): Promise<BillingEvent> {
    const at = verified.occurredAt;
    switch (event.kind) {
      case 'PAYMENT_AUTHORIZED':
        return { type: 'PAYMENT_AUTHORIZED', at };
      case 'PAYMENT_SUCCEEDED':
        return {
          type: 'PAYMENT_SUCCEEDED',
          at,
          reference: event.reference,
          amountMinorUnits: event.amountMinorUnits,
          currency: event.currency,
          periodStart: event.periodStart,
          periodEnd: event.periodEnd,
        };
      case 'PAYMENT_FAILED': {
        const policy = await this.policy(tx);
        return {
          type: 'PAYMENT_FAILED',
          at,
          reference: event.reference,
          gracePeriodDays: policy.gracePeriodDays,
        };
      }
      case 'TRIAL_ENDED':
        return { type: 'TRIAL_ENDED', at };
      case 'CANCEL_SCHEDULED':
        return { type: 'CANCEL_SCHEDULED', at };
      case 'CANCEL_UNDONE':
        return { type: 'CANCEL_UNDONE', at };
      case 'SUBSCRIPTION_ENDED':
        return { type: 'SUBSCRIPTION_ENDED', at };
    }
  }

  // --- operator and system changes -------------------------------------------

  // Starts the one trial of a BILLED subscription under the CURRENT billing
  // policy (copied onto the subscription). Refused when trials are off, the
  // business already had one, or the owner's email already claimed one for
  // another business (BillingTrialClaim).
  async startTrial(
    subscriptionId: string,
    ownerEmail: string,
    actorPlatformOperatorId: string | null,
    now: Date = new Date(),
  ): Promise<BillingState> {
    return runSerializable(this.prisma, async (tx) => {
      const subscription = await this.load(tx, subscriptionId);
      const policy = await this.policy(tx);
      if (policy.trialDays === 0) {
        throw new BillingLifecycleError('TRIALS_DISABLED');
      }
      const result = transition(toBillingState(subscription), {
        type: 'TRIAL_STARTED',
        at: now,
        trialDays: policy.trialDays,
        requiresPaymentMethod: policy.trialRequiresPaymentMethod,
      });
      if (!result.ok) throw new BillingLifecycleError(result.reason);
      try {
        await tx.billingTrialClaim.create({
          data: {
            subscriptionId: subscription.id,
            claimKey: trialClaimKey(ownerEmail, trialClaimSecret()),
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new BillingLifecycleError('TRIAL_ALREADY_USED');
        }
        throw error;
      }
      await this.write(
        tx,
        subscription,
        result.next,
        subscription.lastBillingEventAt,
      );
      await this.history(tx, subscription.id, result.history, {
        source: actorPlatformOperatorId ? 'OPERATOR' : 'SYSTEM',
        billingProviderEventId: null,
        actorPlatformOperatorId,
      });
      return result.next;
    });
  }

  // A change the platform itself decides (e.g. GRACE_EXPIRED, SC3c's
  // scheduler) or an operator requests (plan changes, SC3d). Returns the
  // suspension effect for the caller to enforce.
  async applyInternal(
    subscriptionId: string,
    event: Extract<
      BillingEvent,
      { type: 'GRACE_EXPIRED' | 'UPGRADE_REQUESTED' | 'DOWNGRADE_SCHEDULED' }
    >,
    actorPlatformOperatorId: string | null,
  ): Promise<{ state: BillingState; suspension: SuspensionEffect }> {
    return runSerializable(this.prisma, async (tx) => {
      const subscription = await this.load(tx, subscriptionId);
      const result = transition(toBillingState(subscription), event);
      if (!result.ok) throw new BillingLifecycleError(result.reason);
      if (!result.changed) {
        return { state: result.next, suspension: 'NONE' as SuspensionEffect };
      }
      await this.write(
        tx,
        subscription,
        result.next,
        subscription.lastBillingEventAt,
      );
      await this.history(tx, subscription.id, result.history, {
        source: actorPlatformOperatorId ? 'OPERATOR' : 'SYSTEM',
        billingProviderEventId: null,
        actorPlatformOperatorId,
      });
      return { state: result.next, suspension: result.suspension };
    });
  }

  // --- shared ----------------------------------------------------------------

  private async load(tx: Tx, subscriptionId: string): Promise<SubscriptionRow> {
    const subscription = await tx.tenantSubscription.findUnique({
      where: { id: subscriptionId },
    });
    if (!subscription) throw new BillingLifecycleError('NOT_FOUND');
    return subscription;
  }

  private async policy(tx: Tx) {
    return tx.billingPolicy.findUniqueOrThrow({
      where: { id: DEFAULT_BILLING_POLICY_ID },
    });
  }

  // Compare-and-set on billingStateVersion: a concurrent writer makes this
  // transaction fail (and retry) instead of overwriting its change.
  private async write(
    tx: Tx,
    current: SubscriptionRow,
    next: BillingState,
    lastBillingEventAt: Date | null,
  ): Promise<void> {
    const { count } = await tx.tenantSubscription.updateMany({
      where: {
        id: current.id,
        billingStateVersion: current.billingStateVersion,
      },
      data: {
        ...stateColumns(next),
        lastBillingEventAt,
        billingStateVersion: { increment: 1 },
      },
    });
    if (count !== 1) throw new ConcurrentBillingChange('CONCURRENT_CHANGE');
  }

  private async history(
    tx: Tx,
    subscriptionId: string,
    entries: BillingHistoryEntry[],
    origin: {
      source: 'OPERATOR' | 'BILLING_PROVIDER' | 'SYSTEM';
      billingProviderEventId: string | null;
      actorPlatformOperatorId: string | null;
    },
  ): Promise<void> {
    for (const item of entries) {
      await tx.tenantSubscriptionEvent.create({
        data: {
          subscriptionId,
          type: item.type,
          fromStatus: item.fromStatus,
          toStatus: item.toStatus,
          fromPlanVersionId: item.fromPlanVersionId,
          toPlanVersionId: item.toPlanVersionId,
          planPriceId: item.planPriceId,
          source: origin.source,
          billingProviderEventId: origin.billingProviderEventId,
          actorPlatformOperatorId: origin.actorPlatformOperatorId,
        },
      });
    }
  }
}
