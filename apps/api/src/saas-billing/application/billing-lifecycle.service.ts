import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializable } from '../../prisma/serializable-transaction';
import {
  decideSuspension,
  transition,
  type BillingEvent,
  type BillingHistoryEntry,
  type BillingState,
  type RefusalReason,
  type SuspensionEffect,
} from '../domain/billing-lifecycle';
import {
  eventsFromSnapshot,
  type ProviderSubscriptionSnapshot,
} from '../domain/provider-sync';
import {
  INVOICE_HISTORY_CONFLICT_CASE,
  recordInvoice,
  type InvoiceRecordOutcome,
} from './billing-invoice-history';
import {
  SAAS_BILLING_PROVIDER,
  SaasBillingProviderError,
  type ProviderCheckoutSession,
  type ProviderInvoice,
  type ProviderInvoiceRecord,
  type ProviderPayableInvoice,
  type ProviderSchedule,
  type ProviderLifecycleEvent,
  type SaasBillingProvider,
  type VerifiedBillingProviderEvent,
} from '../provider/saas-billing-provider';
import { billingEnforcementEnabled } from './billing-enforcement.config';
import { enqueueBillingNotice } from './billing-notifications';
import { verifyBilledPrice } from '../domain/plan-change';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';

// SC3b — what the provider says NOW about the thing an event concerns, read
// BEFORE the database transaction (no provider call ever runs while rows are
// locked, and a provider outage leaves the event retryable).
type ProviderFacts =
  | { kind: 'none' }
  | {
      kind: 'checkout';
      session: ProviderCheckoutSession;
      snapshot: ProviderSubscriptionSnapshot | null;
      // SC3c-2 — a restart Checkout: the replaced subscription (null: the
      // provider no longer has it) and the new subscription's first invoice.
      replacement: {
        previous: ProviderSubscriptionSnapshot | null;
        firstInvoice: ProviderInvoice | null;
      } | null;
    }
  | {
      kind: 'snapshot';
      snapshot: ProviderSubscriptionSnapshot;
      // SC3c-2 — for an UNPAID business: its still-open invoices.
      openInvoices: ProviderPayableInvoice[] | null;
      // SC3d-2 — the invoice of a plan change waiting for payment.
      planChangeInvoice?: ProviderInvoice | null;
      // SC3d-3 — the provider's schedule of a scheduled plan change (null:
      // the provider has none; undefined: no scheduled change).
      planChangeSchedule?: ProviderSchedule | null;
    }
  // null: the provider has no such invoice.
  | {
      kind: 'invoice';
      invoice: ProviderInvoice | null;
      // SC3e-1 — when the invoice was read (its billing-history version).
      readAt?: Date;
      // SC3c-2 — a payment of a business that is UNPAID (or an expired
      // trial): the live subscription and its still-open invoices, read so
      // the payment restores access only when nothing is outstanding.
      recovery: {
        snapshot: ProviderSubscriptionSnapshot;
        openInvoices: ProviderPayableInvoice[];
      } | null;
      // SC3d-2 — the invoice is a plan change's: the live subscription.
      planChangeSnapshot?: ProviderSubscriptionSnapshot | null;
      // SC3d-3 — a scheduled change is due: the live subscription and its
      // schedule, so the switch is applied before the payment.
      scheduledChange?: {
        snapshot: ProviderSubscriptionSnapshot;
        schedule: ProviderSchedule | null;
      };
    };

// Applies lifecycle events in order to a state, skipping the ones it refuses
// (each provider-sync event is independently valid or not).
function applyAll(state: BillingState, events: BillingEvent[]) {
  let next = state;
  const history: BillingHistoryEntry[] = [];
  let suspension: SuspensionEffect = 'NONE';
  const refused: string[] = [];
  for (const event of events) {
    const result = transition(next, event);
    if (!result.ok) {
      refused.push(result.reason);
      continue;
    }
    if (!result.changed) continue;
    next = result.next;
    history.push(...result.history);
    if (result.suspension !== 'NONE') suspension = result.suspension;
  }
  return { next, history, suspension, refused };
}

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
      | 'CONCURRENT_CHANGE'
      // SC3c-3 — grace extensions.
      | 'NOT_EXTENDABLE'
      | 'EXTENSION_LIMIT'
      | 'NOT_RECOVERABLE',
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
    recoveryEndsAt: row.recoveryEndsAt,
    graceExceptionEndsAt: row.graceExceptionEndsAt,
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
    recoveryEndsAt: next.recoveryEndsAt,
    graceExceptionEndsAt: next.graceExceptionEndsAt,
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

// SC3b — a retryable (FAILED) outcome is not retried forever: after this many
// attempts, or this long after it first arrived, the event is closed as
// REJECTED and a reconciliation case is opened for an operator. (The
// provider itself stops redelivering after about three days.)
const MAX_RETRY_ATTEMPTS = 12;
const MAX_RETRY_AGE_MS = 72 * 60 * 60 * 1000;

function retriesExhausted(ledger: { attempts: number; receivedAt: Date }) {
  return (
    ledger.attempts + 1 >= MAX_RETRY_ATTEMPTS ||
    Date.now() - ledger.receivedAt.getTime() >= MAX_RETRY_AGE_MS
  );
}

// SC3c-2 — the review case for a replacement the provider created (and may
// have charged) that we could not link. Safe references only (provider ids,
// amounts, our Checkout id) — never a URL. See
// docs/operations/billing-recovery.md.
export const UNLINKED_REPLACEMENT_CASE = 'UNLINKED_REPLACEMENT';

// SC3d-2 — plan change review cases.
export const PLAN_CHANGE_AMOUNT_MISMATCH_CASE = 'PLAN_CHANGE_AMOUNT_MISMATCH';
export const UPGRADE_PAID_NOT_APPLIED_CASE = 'UPGRADE_PAID_NOT_APPLIED';
export const PLAN_CHANGE_UNCERTAIN_CASE = 'PLAN_CHANGE_UNCERTAIN';
// SC3d-3 — a scheduled change the provider no longer holds as agreed.
export const SCHEDULED_CHANGE_DISRUPTED_CASE = 'SCHEDULED_CHANGE_DISRUPTED';
// How long after its date a scheduled switch may take to be seen.
const SWITCH_LAG_MS = 2 * 60 * 60 * 1000;
const OPEN_PLAN_CHANGE = ['REQUESTED', 'AWAITING_PAYMENT', 'REVIEW'];

export type PlanChangeSettlement =
  'APPLIED' | 'ABANDONED' | 'NOT_YET' | 'REVIEW' | 'WAITING';

// Safe references for a plan change review case: the expected and actual
// amounts, our records and the provider's ids — never a URL.
function planChangeDetail(
  change: {
    id: string;
    currency: string;
    previewAmountDueMinorUnits: number | null;
  },
  invoice: {
    externalInvoiceId: string;
    amountPaidMinorUnits: number;
    currency?: string | null;
    status: string;
    externalSubscriptionId: string | null;
  } | null,
  reason: string,
): string {
  return [
    reason,
    `Plan change ${change.id}: expected ${change.previewAmountDueMinorUnits ?? '-'} ${change.currency} (minor units, the confirmed preview).`,
    invoice
      ? `Invoice ${invoice.externalInvoiceId} (${invoice.status}): paid ${invoice.amountPaidMinorUnits} ${(invoice.currency ?? '?').toUpperCase()}; subscription ${invoice.externalSubscriptionId ?? 'unknown'}.`
      : 'Invoice: not available.',
    'Nothing was refunded or changed at the provider.',
  ]
    .join(' ')
    .slice(0, 500);
}

// SC3c-3 — the provider ended a subscription while an operator's grace
// extension or exception was in force: nothing is presented as paid, the
// extension's access ends, and an operator decides what next (complimentary
// access is a separate, explicit action).
export const EXTENSION_ENDED_BY_PROVIDER_CASE = 'EXTENSION_ENDED_BY_PROVIDER';

// SC3c-3 — operator grace extension limits (owner decision D5).
export const GRACE_EXTENSION_MAX_DAYS = 14;
export const GRACE_EXTENSION_EPISODE_MAX_DAYS = 60;
// SC3c-3 — reminders: a grace period / exception ending within this long,
// a trial recovery window ending within RECOVERY_REMINDER_MS.
const GRACE_REMINDER_MS = 3 * 24 * 60 * 60 * 1000;
const RECOVERY_REMINDER_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  // The provider could not be read (outage, rate limit): retryable.
  if (error instanceof SaasBillingProviderError) return 'PROVIDER_ERROR';
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
      const facts = await this.readProvider(verified);
      return await runSerializable(this.prisma, (tx) =>
        this.apply(tx, ledger.id, verified, facts),
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
      // The error class only: messages (database or provider) can carry
      // query detail or identifiers.
      this.logger.error(
        `Billing event ${ledger.id} failed to apply (${outcome}): ${
          error instanceof Error ? error.name : 'unknown'
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

  // SC3b — the provider's current view, for the events that need one.
  private async readProvider(
    verified: VerifiedBillingProviderEvent,
  ): Promise<ProviderFacts> {
    if (verified.livemode !== this.provider.livemode) return { kind: 'none' };
    const event = verified.event;
    switch (event.kind) {
      case 'CHECKOUT_COMPLETED': {
        // Only a session WE created is ever read from the provider.
        const ours = await this.prisma.billingCheckoutSession.findUnique({
          where: { externalSessionId: event.externalSessionId },
          select: { id: true, replacesExternalSubscriptionId: true },
        });
        if (!ours) return { kind: 'none' };
        const session = await this.provider.retrieveCheckoutSession(
          event.externalSessionId,
        );
        const snapshot =
          session.externalSubscriptionId !== null
            ? await this.provider.retrieveSubscription(
                session.externalSubscriptionId,
              )
            : null;
        let replacement: Extract<
          ProviderFacts,
          { kind: 'checkout' }
        >['replacement'] = null;
        if (ours.replacesExternalSubscriptionId !== null) {
          replacement = {
            previous: await this.readSubscriptionOrNull(
              ours.replacesExternalSubscriptionId,
            ),
            firstInvoice:
              snapshot?.latestInvoiceId != null
                ? await this.provider.retrieveInvoice(snapshot.latestInvoiceId)
                : null,
          };
        }
        return { kind: 'checkout', session, snapshot, replacement };
      }
      case 'SUBSCRIPTION_CHANGED':
        // Only a subscription linked to one of OURS is read from the
        // provider (anything else is matched — and ignored or retried — in
        // the transaction without reading it).
        if (!(await this.isLinked(verified))) return { kind: 'none' };
        {
          const waiting = await this.waitingPlanChangeInvoice(verified);
          const scheduled = await this.scheduledPlanChange(verified);
          return {
            kind: 'snapshot',
            planChangeSchedule:
              scheduled === null
                ? undefined
                : await this.provider.retrieveSchedule(scheduled),
            snapshot: await this.provider.retrieveSubscription(
              verified.externalSubscriptionId!,
            ),
            openInvoices: (await this.inRecovery(verified))
              ? await this.provider.listOpenInvoices(
                  verified.externalSubscriptionId!,
                )
              : null,
            planChangeInvoice:
              waiting === null
                ? undefined
                : await this.provider.retrieveInvoice(waiting),
          };
        }
      // SC3e-1 — an invoice (or a credit note on it) of one of OUR
      // subscriptions or customers: its live record.
      case 'INVOICE_CHANGED': {
        const replaced =
          verified.externalSubscriptionId !== null &&
          (await this.prisma.billingCheckoutSession.count({
            where: {
              replacesExternalSubscriptionId: verified.externalSubscriptionId,
              status: 'COMPLETED',
            },
          })) > 0;
        if (
          !replaced &&
          !(await this.isLinked(verified)) &&
          (verified.externalSubscriptionId !== null ||
            verified.externalCustomerId === null ||
            (await this.prisma.tenantSubscription.findUnique({
              where: {
                billingProvider_externalCustomerId: {
                  billingProvider: verified.provider,
                  externalCustomerId: verified.externalCustomerId,
                },
              },
              select: { id: true },
            })) === null)
        ) {
          return { kind: 'none' };
        }
        const invoice = await this.provider.retrieveInvoice(event.reference);
        return { kind: 'invoice', invoice, recovery: null, readAt: new Date() };
      }
      case 'PAYMENT_SUCCEEDED':
      case 'PAYMENT_FAILED': {
        if (!(await this.isLinked(verified))) return { kind: 'none' };
        const invoice = await this.provider.retrieveInvoice(event.reference);
        const readAt = new Date();
        let recovery: Extract<ProviderFacts, { kind: 'invoice' }>['recovery'] =
          null;
        if (
          event.kind === 'PAYMENT_SUCCEEDED' &&
          (await this.inRecovery(verified))
        ) {
          recovery = {
            snapshot: await this.provider.retrieveSubscription(
              verified.externalSubscriptionId!,
            ),
            openInvoices: await this.provider.listOpenInvoices(
              verified.externalSubscriptionId!,
            ),
          };
        }
        // SC3d-2 — a plan change's invoice: the live subscription too.
        const planChange = await this.prisma.billingPlanChange.findFirst({
          where: { externalInvoiceId: event.reference },
          select: { id: true },
        });
        // SC3d-3 — a subscription with a scheduled change: its live view
        // and schedule too, so the switch is settled first (the renewal
        // invoice may arrive before the subscription event).
        const due = await this.scheduledPlanChange(verified);
        const scheduledChange =
          due === null
            ? undefined
            : {
                snapshot: await this.provider.retrieveSubscription(
                  verified.externalSubscriptionId!,
                ),
                schedule: await this.provider.retrieveSchedule(due),
              };
        return {
          kind: 'invoice',
          invoice,
          readAt,
          recovery,
          scheduledChange,
          planChangeSnapshot: planChange
            ? await this.provider.retrieveSubscription(
                verified.externalSubscriptionId!,
              )
            : null,
        };
      }
      default:
        return { kind: 'none' };
    }
  }

  private async apply(
    tx: Tx,
    ledgerId: string,
    verified: VerifiedBillingProviderEvent,
    facts: ProviderFacts,
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

    // FAILED = not applied, retryable (a later delivery is applied) — until
    // its retries are exhausted, when it is closed and handed to review.
    const finish = async (
      requested: 'IGNORED' | 'REJECTED' | 'FAILED',
      outcome: string,
      subscriptionId: string | null,
    ): Promise<BillingEventOutcome> => {
      let status = requested;
      if (status === 'FAILED' && retriesExhausted(ledger)) {
        await this.openCase(
          tx,
          'EVENT_RETRIES_EXHAUSTED',
          subscriptionId,
          ledgerId,
          outcome,
        );
        status = 'REJECTED';
      }
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
    if (verified.event.kind === 'CHECKOUT_COMPLETED') {
      return this.applyCheckout(
        tx,
        ledgerId,
        verified,
        verified.event.externalSessionId,
        facts,
        finish,
      );
    }
    if (verified.event.kind === 'INVOICE_CHANGED') {
      return this.applyInvoiceChanged(tx, ledgerId, verified, facts, finish);
    }
    if (verified.externalSubscriptionId === null) {
      return finish('IGNORED', 'NO_SUBSCRIPTION_REFERENCE', null);
    }
    // The ONLY way an event reaches a business: our stored provider ids.
    let subscription = await tx.tenantSubscription.findUnique({
      where: {
        billingProvider_externalSubscriptionId: {
          billingProvider: verified.provider,
          externalSubscriptionId: verified.externalSubscriptionId,
        },
      },
    });
    if (!subscription) {
      // SC3c-2 — a subscription a business has REPLACED (restart): its late
      // or delayed events never act on the replacement.
      const replaced = await tx.billingCheckoutSession.findFirst({
        where: {
          replacesExternalSubscriptionId: verified.externalSubscriptionId,
          status: 'COMPLETED',
        },
        select: { subscriptionId: true },
      });
      if (replaced) {
        return finish(
          'IGNORED',
          'SUPERSEDED_SUBSCRIPTION',
          replaced.subscriptionId,
        );
      }
      // Not one of our customers (the provider account may carry other
      // business): acknowledged and ignored, never retried. One of ours but
      // not linked yet (delivered before the Checkout completion): retryable.
      if (!(await this.isOurCustomer(tx, verified))) {
        return finish('IGNORED', 'NOT_OURS', null);
      }
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
    // SC3e-1 — a payment event's invoice, read live, joins the billing
    // history (only when it is this subscription's own).
    if (
      (verified.event.kind === 'PAYMENT_SUCCEEDED' ||
        verified.event.kind === 'PAYMENT_FAILED') &&
      facts.kind === 'invoice' &&
      facts.invoice?.record
    ) {
      await this.recordInvoiceHistory(
        tx,
        subscription,
        facts.invoice.record,
        facts.readAt ?? new Date(),
        ledgerId,
      );
    }
    // SC3b — a subscription change is applied from the provider's LIVE view
    // (read just before this transaction), so its delivery order does not
    // matter and the stale rule does not apply.
    if (verified.event.kind === 'SUBSCRIPTION_CHANGED') {
      if (facts.kind !== 'snapshot') {
        return finish('FAILED', 'PROVIDER_READ_MISSING', subscription.id);
      }
      // SC3c-2 — an UNPAID business the provider reports active again with
      // nothing outstanding: the recovery is complete.
      if (
        subscription.status === 'UNPAID' &&
        facts.openInvoices !== null &&
        facts.snapshot.status === 'active' &&
        facts.snapshot.livemode === this.provider.livemode &&
        facts.snapshot.externalSubscriptionId ===
          subscription.externalSubscriptionId &&
        facts.openInvoices.every((open) => open.amountDueMinorUnits <= 0)
      ) {
        const result = transition(toBillingState(subscription), {
          type: 'RECOVERY_CONFIRMED',
          at: verified.occurredAt,
        });
        if (result.ok && result.changed) {
          await this.write(
            tx,
            subscription,
            result.next,
            subscription.lastBillingEventAt,
          );
          await this.history(tx, subscription.id, result.history, {
            source: 'BILLING_PROVIDER',
            billingProviderEventId: ledgerId,
            actorPlatformOperatorId: null,
          });
          await this.enforce(tx, subscription, result.next, result.suspension, {
            source: 'BILLING_PROVIDER',
            billingProviderEventId: ledgerId,
            actorPlatformOperatorId: null,
          });
          return this.applied(
            tx,
            ledgerId,
            subscription.id,
            'RECOVERED UNPAID->ACTIVE',
            result.suspension,
          );
        }
      }
      // SC3d-2 — a plan change waiting for payment (its pending update was
      // applied or expired): settled first, then the usual sync on the
      // refreshed row.
      let current = subscription;
      if (facts.planChangeInvoice !== undefined) {
        const waiting = await tx.billingPlanChange.findFirst({
          where: {
            subscriptionId: subscription.id,
            status: 'AWAITING_PAYMENT',
          },
          select: { id: true },
        });
        if (waiting) {
          await this.settlePlanChange(
            tx,
            waiting.id,
            facts.snapshot,
            facts.planChangeInvoice,
            {
              source: 'BILLING_PROVIDER',
              billingProviderEventId: ledgerId,
              actorPlatformOperatorId: null,
            },
          );
          current = await this.load(tx, subscription.id);
        }
      }
      // SC3d-3 — a scheduled change: applied at the verified switch, or
      // closed / reviewed when the provider no longer holds it.
      if (facts.planChangeSchedule !== undefined) {
        const scheduled = await tx.billingPlanChange.findFirst({
          where: { subscriptionId: subscription.id, status: 'SCHEDULED' },
          select: { id: true },
        });
        if (scheduled) {
          await this.settleScheduledChange(
            tx,
            scheduled.id,
            facts.snapshot,
            facts.planChangeSchedule,
            new Date(),
            {
              source: 'BILLING_PROVIDER',
              billingProviderEventId: ledgerId,
              actorPlatformOperatorId: null,
            },
          );
          current = await this.load(tx, subscription.id);
        }
      }
      return this.applySnapshot(
        tx,
        ledgerId,
        verified,
        current,
        facts.snapshot,
        finish,
      );
    }
    // SC3b — a payment event is checked against the provider's live invoice:
    // it must belong to THIS subscription; a failure already superseded by a
    // payment is not applied; a "paid" invoice must really be paid.
    if (
      verified.event.kind === 'PAYMENT_SUCCEEDED' ||
      verified.event.kind === 'PAYMENT_FAILED'
    ) {
      // Never applied without the live invoice (linked after the read:
      // retryable).
      if (facts.kind !== 'invoice') {
        return finish('FAILED', 'PROVIDER_READ_MISSING', subscription.id);
      }
      // SC3d-3 — a scheduled change whose date has come: the provider's
      // switch is applied BEFORE the renewal payment (owner decision D1), so
      // a failed renewal is delinquency at the NEW plan and price.
      if (facts.scheduledChange !== undefined) {
        const scheduled = await tx.billingPlanChange.findFirst({
          where: { subscriptionId: subscription.id, status: 'SCHEDULED' },
          select: { id: true },
        });
        if (scheduled) {
          const settled = await this.settleScheduledChange(
            tx,
            scheduled.id,
            facts.scheduledChange.snapshot,
            facts.scheduledChange.schedule,
            new Date(),
            {
              source: 'BILLING_PROVIDER',
              billingProviderEventId: ledgerId,
              actorPlatformOperatorId: null,
            },
          );
          if (settled !== 'WAITING') {
            subscription = await this.load(tx, subscription.id);
          }
        }
      }
      const invoice = facts.invoice;
      if (
        invoice === null ||
        invoice.livemode !== this.provider.livemode ||
        invoice.externalSubscriptionId !==
          subscription.externalSubscriptionId ||
        (invoice.externalCustomerId !== null &&
          invoice.externalCustomerId !== subscription.externalCustomerId)
      ) {
        await this.openCase(tx, 'INVOICE_MISMATCH', subscription.id, ledgerId);
        return finish('REJECTED', 'INVOICE_MISMATCH', subscription.id);
      }
      // SC3d-2 — the invoice of a plan change: settled against the live
      // subscription, never treated as an ordinary payment or delinquency.
      const planChange = await tx.billingPlanChange.findFirst({
        where: { externalInvoiceId: invoice.externalInvoiceId },
      });
      // A plan change invoice seen before its change recorded it (the
      // confirmation is still finishing): retried, never an ordinary payment.
      if (
        planChange === null &&
        invoice.billingReason === 'subscription_update' &&
        (await tx.billingPlanChange.count({
          where: { subscriptionId: subscription.id, status: 'REQUESTED' },
        })) > 0
      ) {
        return finish(
          'FAILED',
          'PLAN_CHANGE_NOT_RECORDED_YET',
          subscription.id,
        );
      }
      // A plan change invoice no recorded change matches (e.g. its change
      // was closed for review before the invoice was recorded): never an
      // ordinary payment and NEVER a delinquency — reviewed.
      if (
        planChange === null &&
        invoice.billingReason === 'subscription_update'
      ) {
        await this.openCase(
          tx,
          PLAN_CHANGE_UNCERTAIN_CASE,
          subscription.id,
          ledgerId,
          `A plan change invoice (${invoice.externalInvoiceId}, ${invoice.status}) matches no recorded plan change. Not applied as a payment or a failure.`,
        );
        return finish(
          'IGNORED',
          'PLAN_CHANGE_INVOICE_UNLINKED',
          subscription.id,
        );
      }
      if (planChange !== null) {
        if (planChange.subscriptionId !== subscription.id) {
          await this.openCase(
            tx,
            'INVOICE_MISMATCH',
            subscription.id,
            ledgerId,
          );
          return finish('REJECTED', 'INVOICE_MISMATCH', subscription.id);
        }
        // A failed attempt: the change keeps waiting (owner decision D2).
        if (verified.event.kind === 'PAYMENT_FAILED') {
          return finish(
            'IGNORED',
            'PLAN_CHANGE_PAYMENT_PENDING',
            subscription.id,
          );
        }
        if (!OPEN_PLAN_CHANGE.includes(planChange.status)) {
          // Paid after we closed it: never adopted silently.
          if (invoice.status === 'paid' && planChange.status !== 'APPLIED') {
            await this.openCase(
              tx,
              UPGRADE_PAID_NOT_APPLIED_CASE,
              subscription.id,
              ledgerId,
              planChangeDetail(
                planChange,
                invoice,
                'Paid after the change was closed.',
              ),
            );
          }
          return finish('IGNORED', 'PLAN_CHANGE_CLOSED', subscription.id);
        }
        if (facts.planChangeSnapshot == null) {
          return finish('FAILED', 'PROVIDER_READ_MISSING', subscription.id);
        }
        const settled = await this.settlePlanChange(
          tx,
          planChange.id,
          facts.planChangeSnapshot,
          invoice,
          {
            source: 'BILLING_PROVIDER',
            billingProviderEventId: ledgerId,
            actorPlatformOperatorId: null,
          },
        );
        if (settled === 'APPLIED') {
          return this.applied(
            tx,
            ledgerId,
            subscription.id,
            'PLAN_CHANGE_APPLIED',
            'NONE',
          );
        }
        if (settled === 'NOT_YET') {
          // The provider has not applied it yet: retryable (and reviewed if it
          // never completes).
          return finish(
            'FAILED',
            'PLAN_CHANGE_NOT_APPLIED_YET',
            subscription.id,
          );
        }
        return finish('IGNORED', `PLAN_CHANGE_${settled}`, subscription.id);
      }
      if (
        verified.event.kind === 'PAYMENT_FAILED' &&
        invoice.status === 'paid'
      ) {
        return finish('IGNORED', 'SUPERSEDED_BY_PAYMENT', subscription.id);
      }
      if (
        verified.event.kind === 'PAYMENT_SUCCEEDED' &&
        invoice.status !== 'paid'
      ) {
        await this.openCase(tx, 'INVOICE_NOT_PAID', subscription.id, ledgerId);
        return finish('REJECTED', 'INVOICE_NOT_PAID', subscription.id);
      }
      // SC3c-2 — paying ONE invoice of an UNPAID business (or an expired
      // trial) restores it only when the provider's live subscription is
      // active again and nothing else is outstanding. Otherwise the payment
      // is not applied yet: retryable (the provider redelivers; the last
      // payment then finds nothing outstanding), and reviewed if it never
      // completes.
      if (
        verified.event.kind === 'PAYMENT_SUCCEEDED' &&
        (subscription.status === 'UNPAID' ||
          subscription.status === 'TRIAL_EXPIRED')
      ) {
        const recovery = facts.recovery;
        if (recovery === null) {
          return finish('FAILED', 'PROVIDER_READ_MISSING', subscription.id);
        }
        const outstanding = recovery.openInvoices.filter(
          (open) =>
            open.externalInvoiceId !== invoice.externalInvoiceId &&
            open.amountDueMinorUnits > 0,
        );
        if (
          recovery.snapshot.externalSubscriptionId !==
            subscription.externalSubscriptionId ||
          recovery.snapshot.livemode !== this.provider.livemode ||
          recovery.snapshot.status !== 'active' ||
          outstanding.length > 0
        ) {
          return finish('FAILED', 'RECOVERY_INCOMPLETE', subscription.id);
        }
      }
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
    await this.enforce(tx, subscription, result.next, result.suspension, {
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
    event: Exclude<
      ProviderLifecycleEvent,
      {
        kind:
          | 'UNSUPPORTED'
          | 'CHECKOUT_COMPLETED'
          | 'SUBSCRIPTION_CHANGED'
          | 'INVOICE_CHANGED';
      }
    >,
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
        return {
          type: 'TRIAL_ENDED',
          at,
          trialRecoveryDays: (await this.policy(tx)).trialRecoveryDays,
        };
      case 'CANCEL_SCHEDULED':
        return { type: 'CANCEL_SCHEDULED', at };
      case 'CANCEL_UNDONE':
        return { type: 'CANCEL_UNDONE', at };
      case 'SUBSCRIPTION_ENDED':
        return {
          type: 'SUBSCRIPTION_ENDED',
          at,
          trialRecoveryDays: (await this.policy(tx)).trialRecoveryDays,
        };
    }
  }

  // SC3b — the owner completed a hosted Checkout. Linked ONLY when the
  // session is one WE created for this subscription, for the customer WE
  // stored, and the provider (read live) says it is complete. The provider
  // subscription it created is then linked and our state brought in line
  // with it.
  private async applyCheckout(
    tx: Tx,
    ledgerId: string,
    verified: VerifiedBillingProviderEvent,
    externalSessionId: string,
    facts: ProviderFacts,
    finish: (
      status: 'IGNORED' | 'REJECTED' | 'FAILED',
      outcome: string,
      subscriptionId: string | null,
    ) => Promise<BillingEventOutcome>,
  ): Promise<BillingEventOutcome> {
    const checkout = await tx.billingCheckoutSession.findUnique({
      where: { externalSessionId },
    });
    if (!checkout) {
      // Not for one of our customers: ignored. Ours but not recorded (yet):
      // retryable, then handed to review.
      if (!(await this.isOurCustomer(tx, verified))) {
        return finish('IGNORED', 'NOT_OURS', null);
      }
      return finish('FAILED', 'NO_MATCHING_CHECKOUT', null);
    }
    const subscription = await this.load(tx, checkout.subscriptionId);
    // SC3c-2 — a RESTART Checkout that ends without a link — rejected, or a
    // retryable failure whose retries ran out — leaves a provider
    // subscription (possibly paid) that is not ours to use: it is recorded
    // for an operator with safe references (never discarded, never given
    // access, never changed at the provider). "Not complete" means nothing
    // was paid and is not recorded.
    const outcome =
      checkout.replacesExternalSubscriptionId === null
        ? finish
        : async (
            status: 'IGNORED' | 'REJECTED' | 'FAILED',
            code: string,
            subscriptionId: string | null,
          ): Promise<BillingEventOutcome> => {
            if (status !== 'IGNORED' && code !== 'CHECKOUT_NOT_COMPLETE') {
              const ledger = await tx.billingProviderEvent.findUniqueOrThrow({
                where: { id: ledgerId },
                select: { attempts: true, receivedAt: true },
              });
              if (status === 'REJECTED' || retriesExhausted(ledger)) {
                const read = facts.kind === 'checkout' ? facts : null;
                await this.recordUnlinkedReplacement(tx, ledgerId, {
                  subscriptionId: subscription.id,
                  checkoutId: checkout.id,
                  replaces: checkout.replacesExternalSubscriptionId,
                  externalSubscriptionId:
                    read?.session.externalSubscriptionId ?? null,
                  externalCustomerId:
                    read?.session.externalCustomerId ??
                    verified.externalCustomerId,
                  providerStatus: read?.snapshot?.status ?? 'unknown',
                  firstInvoice: read?.replacement?.firstInvoice ?? null,
                  reason: code,
                });
              }
            }
            return finish(status, code, subscriptionId);
          };
    if (facts.kind !== 'checkout') {
      return outcome('FAILED', 'PROVIDER_READ_MISSING', subscription.id);
    }
    const { session, snapshot } = facts;
    if (
      session.externalSessionId !== externalSessionId ||
      session.livemode !== this.provider.livemode
    ) {
      return outcome('REJECTED', 'CHECKOUT_MISMATCH', subscription.id);
    }
    if (session.status !== 'complete') {
      return outcome('FAILED', 'CHECKOUT_NOT_COMPLETE', subscription.id);
    }
    if (
      subscription.billingMode !== 'BILLED' ||
      subscription.billingProvider !== verified.provider
    ) {
      return outcome('REJECTED', 'NOT_BILLED', subscription.id);
    }
    if (
      session.externalCustomerId !== subscription.externalCustomerId ||
      (verified.externalCustomerId !== null &&
        verified.externalCustomerId !== subscription.externalCustomerId)
    ) {
      await this.openCase(
        tx,
        'CHECKOUT_CUSTOMER_MISMATCH',
        subscription.id,
        ledgerId,
      );
      return outcome('REJECTED', 'CUSTOMER_MISMATCH', subscription.id);
    }
    if (
      verified.claimedTenantId !== null &&
      verified.claimedTenantId !== subscription.subscriberTenantId
    ) {
      return outcome('REJECTED', 'TENANT_CLAIM_MISMATCH', subscription.id);
    }
    const externalSubscriptionId = session.externalSubscriptionId;
    if (
      externalSubscriptionId === null ||
      snapshot === null ||
      snapshot.externalSubscriptionId !== externalSubscriptionId ||
      snapshot.externalCustomerId !== subscription.externalCustomerId
    ) {
      return outcome(
        'FAILED',
        'CHECKOUT_SUBSCRIPTION_UNREADABLE',
        subscription.id,
      );
    }
    // SC3c-2 — a restart Checkout replaces the ENDED subscription.
    if (checkout.replacesExternalSubscriptionId !== null) {
      return this.applyReplacement(
        tx,
        ledgerId,
        checkout,
        subscription,
        externalSubscriptionId,
        snapshot,
        facts.replacement,
        outcome,
      );
    }
    if (
      subscription.externalSubscriptionId !== null &&
      subscription.externalSubscriptionId !== externalSubscriptionId
    ) {
      // Already linked to another provider subscription: never replaced
      // automatically.
      await this.openCase(
        tx,
        'CHECKOUT_LINKED_ELSEWHERE',
        subscription.id,
        ledgerId,
      );
      return outcome('REJECTED', 'LINKED_ELSEWHERE', subscription.id);
    }

    await tx.billingCheckoutSession.updateMany({
      where: { id: checkout.id, status: 'OPEN' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    const sync = await this.syncFromSnapshot(
      tx,
      subscription.id,
      toBillingState(subscription),
      snapshot,
      checkout,
      verified.occurredAt,
    );
    if (sync.unexpectedTrial) {
      await this.openCase(tx, 'UNEXPECTED_TRIAL', subscription.id, ledgerId);
    }
    const result = applyAll(toBillingState(subscription), sync.events);
    const linking = subscription.externalSubscriptionId === null;
    if (!linking && result.history.length === 0) {
      return outcome('IGNORED', 'NO_CHANGE', subscription.id);
    }
    await this.write(
      tx,
      subscription,
      result.next,
      // Not advanced: the change came from the provider's live view, and
      // an earlier-created payment event delivered after it must still apply.
      subscription.lastBillingEventAt,
      linking ? { externalSubscriptionId } : {},
    );
    await this.history(tx, subscription.id, result.history, {
      source: 'BILLING_PROVIDER',
      billingProviderEventId: ledgerId,
      actorPlatformOperatorId: null,
    });
    await this.enforce(tx, subscription, result.next, result.suspension, {
      source: 'BILLING_PROVIDER',
      billingProviderEventId: ledgerId,
      actorPlatformOperatorId: null,
    });
    return this.applied(
      tx,
      ledgerId,
      subscription.id,
      `${linking ? 'LINKED ' : ''}${subscription.status}->${result.next.status}`,
      result.suspension,
    );
  }

  // SC3c-2 — links the business to the NEW provider subscription of a
  // completed restart Checkout, replacing the ended one — only when:
  //   * the business still holds the subscription this Checkout replaces,
  //     and is still TRIAL_EXPIRED or CANCELED;
  //   * the provider confirms the replaced subscription has ENDED;
  //   * the new subscription is active, without a trial (a free trial is
  //     never granted this way), and its first invoice is verifiably PAID.
  // Applied atomically (one serializable transaction, compare-and-set on the
  // subscription, at most one completed replacement per replaced
  // subscription). Paid features return only then; the billing suspension
  // (if enforcement applied one) is lifted the same way as for a payment.
  private async applyReplacement(
    tx: Tx,
    ledgerId: string,
    checkout: { id: string; replacesExternalSubscriptionId: string | null },
    subscription: SubscriptionRow,
    externalSubscriptionId: string,
    snapshot: ProviderSubscriptionSnapshot,
    replacement: Extract<ProviderFacts, { kind: 'checkout' }>['replacement'],
    finish: (
      status: 'IGNORED' | 'REJECTED' | 'FAILED',
      outcome: string,
      subscriptionId: string | null,
    ) => Promise<BillingEventOutcome>,
  ): Promise<BillingEventOutcome> {
    if (subscription.externalSubscriptionId === externalSubscriptionId) {
      return finish('IGNORED', 'ALREADY_REPLACED', subscription.id);
    }
    // Not linked: a REJECTED outcome — or a retryable one whose retries are
    // exhausted — leaves a provider subscription (possibly paid) that is not
    // ours to use. It is recorded for an operator (never discarded, never
    // given access, never changed at the provider).
    // (`finish` here is applyCheckout's restart outcome: it records the
    // unlinked replacement for an operator.)
    const notLinked = (
      status: 'REJECTED' | 'FAILED',
      reason: string,
    ): Promise<BillingEventOutcome> => finish(status, reason, subscription.id);
    if (
      subscription.externalSubscriptionId !==
      checkout.replacesExternalSubscriptionId
    ) {
      return notLinked('REJECTED', 'LINKED_ELSEWHERE');
    }
    if (
      subscription.status !== 'TRIAL_EXPIRED' &&
      subscription.status !== 'CANCELED'
    ) {
      return notLinked('REJECTED', 'NOT_REPLACEABLE');
    }
    if (replacement === null) {
      return notLinked('FAILED', 'PROVIDER_READ_MISSING');
    }
    const previous = replacement.previous;
    if (
      previous === null ||
      previous.externalCustomerId !== subscription.externalCustomerId
    ) {
      return notLinked('REJECTED', 'PREVIOUS_UNVERIFIABLE');
    }
    if (
      previous.status !== 'canceled' &&
      previous.status !== 'incomplete_expired'
    ) {
      return notLinked('FAILED', 'PREVIOUS_NOT_ENDED');
    }
    if (
      snapshot.status === 'trialing' ||
      snapshot.trialStart !== null ||
      snapshot.trialEnd !== null
    ) {
      return notLinked('REJECTED', 'UNEXPECTED_TRIAL');
    }
    const paid = replacement.firstInvoice;
    if (
      snapshot.status !== 'active' ||
      paid === null ||
      paid.livemode !== this.provider.livemode ||
      paid.status !== 'paid' ||
      paid.amountPaidMinorUnits <= 0 ||
      paid.externalSubscriptionId !== externalSubscriptionId ||
      paid.externalCustomerId !== subscription.externalCustomerId
    ) {
      return notLinked('FAILED', 'REPLACEMENT_NOT_PAID');
    }

    const result = transition(toBillingState(subscription), {
      type: 'SUBSCRIPTION_REPLACED',
      at: new Date(),
    });
    if (!result.ok) {
      return notLinked('REJECTED', result.reason);
    }
    await tx.billingCheckoutSession.updateMany({
      where: { id: checkout.id, status: 'OPEN' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    await this.write(
      tx,
      subscription,
      result.next,
      subscription.lastBillingEventAt,
      { externalSubscriptionId },
    );
    await this.history(tx, subscription.id, result.history, {
      source: 'BILLING_PROVIDER',
      billingProviderEventId: ledgerId,
      actorPlatformOperatorId: null,
    });
    await this.enforce(tx, subscription, result.next, result.suspension, {
      source: 'BILLING_PROVIDER',
      billingProviderEventId: ledgerId,
      actorPlatformOperatorId: null,
    });
    return this.applied(
      tx,
      ledgerId,
      subscription.id,
      `REPLACED ${subscription.status}->${result.next.status}`,
      result.suspension,
    );
  }

  // SC3c-2 — records an unlinked replacement for an operator: one OPEN case
  // per business (UNLINKED_REPLACEMENT), and — should a second arrive while
  // it is open — a case of its own keyed by the event, so no paid
  // subscription is ever folded away.
  private async recordUnlinkedReplacement(
    tx: Tx,
    ledgerId: string,
    facts: {
      subscriptionId: string;
      checkoutId: string;
      replaces: string | null;
      externalSubscriptionId: string | null;
      externalCustomerId: string | null;
      providerStatus: string;
      firstInvoice: ProviderInvoice | null;
      reason: string;
    },
  ): Promise<void> {
    const invoice = facts.firstInvoice;
    const detail = [
      `Reason ${facts.reason}.`,
      `Provider subscription ${facts.externalSubscriptionId ?? 'unknown'} (${facts.providerStatus}), customer ${facts.externalCustomerId ?? 'unknown'}.`,
      invoice
        ? `First invoice ${invoice.externalInvoiceId}: ${invoice.status}, ${invoice.amountPaidMinorUnits} paid (minor units).`
        : 'First invoice: not available.',
      `Our Checkout ${facts.checkoutId}; replaces ${facts.replaces ?? '-'}.`,
      'Not linked; no access granted; nothing changed at the provider.',
    ]
      .join(' ')
      .slice(0, 500);
    const open = await tx.billingReconciliationCase.findFirst({
      where: {
        status: 'OPEN',
        kind: UNLINKED_REPLACEMENT_CASE,
        subscriptionId: facts.subscriptionId,
      },
      select: { id: true },
    });
    const created = await tx.billingReconciliationCase.create({
      data: {
        kind: UNLINKED_REPLACEMENT_CASE,
        subscriptionId: open ? null : facts.subscriptionId,
        billingProviderEventId: ledgerId,
        detail,
      },
      select: { id: true },
    });
    // SC3c-3 — the business is told its restart is being reviewed (no
    // second restart is possible meanwhile).
    await enqueueBillingNotice(tx, {
      subscriptionId: facts.subscriptionId,
      kind: 'RESTART_UNDER_REVIEW',
      subject: created.id,
      caseId: created.id,
    });
  }

  // SC3c-2 — a provider subscription, or null when the provider has none.
  private async readSubscriptionOrNull(
    externalSubscriptionId: string,
  ): Promise<ProviderSubscriptionSnapshot | null> {
    try {
      return await this.provider.retrieveSubscription(externalSubscriptionId);
    } catch (error) {
      if (
        error instanceof SaasBillingProviderError &&
        error.code === 'resource_missing'
      ) {
        return null;
      }
      throw error;
    }
  }

  // SC3c-2 — whether the event's (linked) subscription is UNPAID or an
  // expired trial, i.e. a payment would be a recovery.
  private async inRecovery(
    verified: VerifiedBillingProviderEvent,
  ): Promise<boolean> {
    if (verified.externalSubscriptionId === null) return false;
    const found = await this.prisma.tenantSubscription.findUnique({
      where: {
        billingProvider_externalSubscriptionId: {
          billingProvider: verified.provider,
          externalSubscriptionId: verified.externalSubscriptionId,
        },
      },
      select: { status: true },
    });
    return found?.status === 'UNPAID' || found?.status === 'TRIAL_EXPIRED';
  }

  // SC3b — bring our state in line with the provider's live subscription.
  private async applySnapshot(
    tx: Tx,
    ledgerId: string,
    verified: VerifiedBillingProviderEvent,
    subscription: SubscriptionRow,
    snapshot: ProviderSubscriptionSnapshot,
    finish: (
      status: 'IGNORED' | 'REJECTED' | 'FAILED',
      outcome: string,
      subscriptionId: string | null,
    ) => Promise<BillingEventOutcome>,
  ): Promise<BillingEventOutcome> {
    if (
      snapshot.livemode !== this.provider.livemode ||
      snapshot.externalSubscriptionId !== subscription.externalSubscriptionId ||
      snapshot.externalCustomerId !== subscription.externalCustomerId
    ) {
      await this.openCase(
        tx,
        'SUBSCRIPTION_MISMATCH',
        subscription.id,
        ledgerId,
      );
      return finish('REJECTED', 'SUBSCRIPTION_MISMATCH', subscription.id);
    }
    // SC3d-1 — the provider must bill exactly OUR recorded price (one item,
    // quantity 1). A difference is reviewed, never adopted: the state sync
    // below still applies (it never changes the plan or price).
    if (
      snapshot.items !== undefined &&
      snapshot.items.length > 0 &&
      subscription.planPriceId !== null
    ) {
      const price = await tx.subscriptionPlanPrice.findUnique({
        where: { id: subscription.planPriceId },
        select: { externalPriceId: true },
      });
      const billed = verifyBilledPrice(
        { ...snapshot, scheduleId: null, hasPendingUpdate: false },
        price?.externalPriceId ?? null,
      );
      // SC3d-3 — the target of a change in flight (a switch not settled
      // yet) is expected, not a mismatch; it is settled by its own path.
      const live =
        snapshot.items.length === 1 ? snapshot.items[0].externalPriceId : null;
      const inFlight =
        live !== null &&
        (await tx.billingPlanChange.count({
          where: {
            subscriptionId: subscription.id,
            status: { in: ['SCHEDULED', 'AWAITING_PAYMENT', 'REQUESTED'] },
            toPlanPrice: { externalPriceId: live },
          },
        })) > 0;
      if (!billed.ok && !inFlight) {
        await this.openCase(
          tx,
          'PRICE_MISMATCH',
          subscription.id,
          ledgerId,
          `The provider subscription does not bill our recorded price (${billed.problem}).`,
        );
      }
    }
    const completed = await tx.billingCheckoutSession.findFirst({
      where: { subscriptionId: subscription.id, status: 'COMPLETED' },
      orderBy: { completedAt: 'desc' },
      select: {
        trialDays: true,
        requiresPaymentMethod: true,
        trialClaimKey: true,
      },
    });
    const state = toBillingState(subscription);
    const sync = await this.syncFromSnapshot(
      tx,
      subscription.id,
      state,
      snapshot,
      completed,
      verified.occurredAt,
    );
    if (sync.unexpectedTrial) {
      await this.openCase(tx, 'UNEXPECTED_TRIAL', subscription.id, ledgerId);
    }
    const result = applyAll(state, sync.events);
    if (result.history.length === 0) {
      return finish('IGNORED', 'NO_CHANGE', subscription.id);
    }
    await this.write(
      tx,
      subscription,
      result.next,
      // Not advanced: the change came from the provider's live view, and
      // an earlier-created payment event delivered after it must still apply.
      subscription.lastBillingEventAt,
    );
    await this.history(tx, subscription.id, result.history, {
      source: 'BILLING_PROVIDER',
      billingProviderEventId: ledgerId,
      actorPlatformOperatorId: null,
    });
    await this.enforce(tx, subscription, result.next, result.suspension, {
      source: 'BILLING_PROVIDER',
      billingProviderEventId: ledgerId,
      actorPlatformOperatorId: null,
    });
    return this.applied(
      tx,
      ledgerId,
      subscription.id,
      `${subscription.status}->${result.next.status}`,
      result.suspension,
    );
  }

  // SC3b — the events the provider's live subscription implies. The
  // one-time trial is CONSUMED only here, in the same transaction that
  // records the trial: when the provider has verifiably created the trial
  // subscription for the trial OUR Checkout offered. If the owner's claim was
  // already used by another business, the trial is not accepted: it is
  // reviewed as UNEXPECTED_TRIAL. A cardless trial then ends without
  // charging; a card-required one would be charged at its end (the owner
  // consented to that) unless an operator acts on the case. Operator trials
  // refuse a claim an open Checkout holds, so this is a last-resort guard.
  private async syncFromSnapshot(
    tx: Tx,
    subscriptionId: string,
    state: BillingState,
    snapshot: ProviderSubscriptionSnapshot,
    checkout: {
      trialDays: number;
      requiresPaymentMethod: boolean;
      trialClaimKey: string | null;
    } | null,
    at: Date,
  ) {
    const offered =
      checkout === null
        ? null
        : {
            trialDays: checkout.trialDays,
            requiresPaymentMethod: checkout.requiresPaymentMethod,
          };
    const { trialRecoveryDays } = await this.policy(tx);
    const sync = eventsFromSnapshot(
      state,
      snapshot,
      offered,
      at,
      trialRecoveryDays,
    );
    if (!sync.events.some((event) => event.type === 'TRIAL_STARTED')) {
      return sync;
    }
    if (
      await this.consumeTrialClaim(
        tx,
        subscriptionId,
        checkout?.trialClaimKey ?? null,
      )
    ) {
      return sync;
    }
    return eventsFromSnapshot(state, snapshot, null, at, trialRecoveryDays);
  }

  // Records the owner's one-time trial claim for this subscription. Retried
  // deliveries find their own claim; a claim another business consumed is
  // refused (a concurrent consumer fails the serializable transaction and
  // the event is retried, then refused).
  private async consumeTrialClaim(
    tx: Tx,
    subscriptionId: string,
    claimKey: string | null,
  ): Promise<boolean> {
    if (claimKey === null) return false;
    const mine = await tx.billingTrialClaim.findUnique({
      where: { subscriptionId },
      select: { claimKey: true },
    });
    if (mine) return mine.claimKey === claimKey;
    const taken = await tx.billingTrialClaim.findUnique({
      where: { claimKey },
      select: { id: true },
    });
    if (taken) return false;
    await tx.billingTrialClaim.create({ data: { subscriptionId, claimKey } });
    return true;
  }

  // Whether the event names a provider subscription linked to one of ours.
  private async isLinked(
    verified: VerifiedBillingProviderEvent,
  ): Promise<boolean> {
    if (verified.externalSubscriptionId === null) return false;
    const found = await this.prisma.tenantSubscription.findUnique({
      where: {
        billingProvider_externalSubscriptionId: {
          billingProvider: verified.provider,
          externalSubscriptionId: verified.externalSubscriptionId,
        },
      },
      select: { id: true },
    });
    return found !== null;
  }

  // Whether the event names a customer WE created (matched only through our
  // stored provider ids).
  private async isOurCustomer(
    tx: Tx,
    verified: VerifiedBillingProviderEvent,
  ): Promise<boolean> {
    if (verified.externalCustomerId === null) return false;
    const found = await tx.tenantSubscription.findUnique({
      where: {
        billingProvider_externalCustomerId: {
          billingProvider: verified.provider,
          externalCustomerId: verified.externalCustomerId,
        },
      },
      select: { id: true },
    });
    return found !== null;
  }

  // SC3e-1 — an invoice changed (or a credit note was issued on it): its
  // live record joins the billing history of the subscription it belongs
  // to — found through OUR stored provider ids from the invoice itself, and
  // checked against the event's own references. Nothing else changes.
  private async applyInvoiceChanged(
    tx: Tx,
    ledgerId: string,
    verified: VerifiedBillingProviderEvent,
    facts: ProviderFacts,
    finish: (
      status: 'IGNORED' | 'REJECTED' | 'FAILED',
      outcome: string,
      subscriptionId: string | null,
    ) => Promise<BillingEventOutcome>,
  ): Promise<BillingEventOutcome> {
    if (facts.kind === 'none') return finish('IGNORED', 'NOT_OURS', null);
    if (facts.kind !== 'invoice') {
      return finish('FAILED', 'PROVIDER_READ_MISSING', null);
    }
    if (facts.invoice === null) {
      return finish('IGNORED', 'INVOICE_NOT_FOUND', null);
    }
    const record = facts.invoice.record;
    if (!record || record.externalSubscriptionId === null) {
      // Not a subscription invoice, or not readable faithfully.
      return finish('IGNORED', 'INVOICE_NOT_RECORDED', null);
    }
    let subscription = await tx.tenantSubscription.findUnique({
      where: {
        billingProvider_externalSubscriptionId: {
          billingProvider: verified.provider,
          externalSubscriptionId: record.externalSubscriptionId,
        },
      },
    });
    // SC3e-2 (owner decision D6) — an earlier subscription a completed
    // restart Checkout of ours replaced: still that business's history.
    if (!subscription) {
      const replaced = await tx.billingCheckoutSession.findFirst({
        where: {
          replacesExternalSubscriptionId: record.externalSubscriptionId,
          status: 'COMPLETED',
        },
        select: { subscriptionId: true },
      });
      subscription = replaced
        ? await tx.tenantSubscription.findUnique({
            where: { id: replaced.subscriptionId },
          })
        : null;
      if (subscription && subscription.billingProvider !== verified.provider) {
        subscription = null;
      }
    }
    if (!subscription) return finish('IGNORED', 'NOT_OURS', null);
    if (
      (verified.externalSubscriptionId !== null &&
        verified.externalSubscriptionId !== record.externalSubscriptionId) ||
      subscription.billingMode !== 'BILLED' ||
      (verified.externalCustomerId !== null &&
        verified.externalCustomerId !== subscription.externalCustomerId) ||
      record.externalCustomerId !== subscription.externalCustomerId
    ) {
      await this.openCase(tx, 'INVOICE_MISMATCH', subscription.id, ledgerId);
      return finish('REJECTED', 'INVOICE_MISMATCH', subscription.id);
    }
    if (
      verified.claimedTenantId !== null &&
      verified.claimedTenantId !== subscription.subscriberTenantId
    ) {
      return finish('REJECTED', 'TENANT_CLAIM_MISMATCH', subscription.id);
    }
    const outcome = await this.recordInvoiceHistory(
      tx,
      subscription,
      record,
      facts.readAt ?? new Date(),
      ledgerId,
    );
    if (outcome === 'CONFLICT') {
      return finish('REJECTED', INVOICE_HISTORY_CONFLICT_CASE, subscription.id);
    }
    return this.applied(
      tx,
      ledgerId,
      subscription.id,
      `INVOICE_${outcome}`,
      'NONE',
    );
  }

  // SC3e-1 — records an invoice in the billing history; a contradiction is
  // reviewed (nothing written).
  async recordInvoiceHistory(
    tx: Tx,
    subscription: {
      id: string;
      billingProvider: string | null;
      externalSubscriptionId: string | null;
      externalCustomerId: string | null;
    },
    record: ProviderInvoiceRecord,
    readAt: Date,
    ledgerId: string | null,
  ): Promise<InvoiceRecordOutcome> {
    const outcome = await recordInvoice(
      tx,
      subscription,
      record,
      readAt,
      this.provider.livemode,
    );
    if (outcome === 'CONFLICT') {
      await this.openCase(
        tx,
        INVOICE_HISTORY_CONFLICT_CASE,
        subscription.id,
        ledgerId,
        `Invoice ${record.externalInvoiceId} (${record.status}) contradicts the recorded billing history. Nothing was written.`,
      );
    }
    return outcome;
  }

  private async applied(
    tx: Tx,
    ledgerId: string,
    subscriptionId: string,
    outcome: string,
    suspension: SuspensionEffect,
  ): Promise<BillingEventOutcome> {
    await tx.billingProviderEvent.update({
      where: { id: ledgerId },
      data: {
        status: 'APPLIED',
        outcome: outcome.slice(0, 500),
        subscriptionId,
        processedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    return {
      status: 'APPLIED',
      duplicate: false,
      subscriptionId,
      suspension,
      outcome,
    };
  }

  // SC3d-2 — the invoice id of a plan change waiting for payment on the
  // event's subscription (null: none).
  private async waitingPlanChangeInvoice(
    verified: VerifiedBillingProviderEvent,
  ): Promise<string | null> {
    if (verified.externalSubscriptionId === null) return null;
    const waiting = await this.prisma.billingPlanChange.findFirst({
      where: {
        status: 'AWAITING_PAYMENT',
        externalInvoiceId: { not: null },
        subscription: {
          billingProvider: verified.provider,
          externalSubscriptionId: verified.externalSubscriptionId,
        },
      },
      select: { externalInvoiceId: true },
    });
    return waiting?.externalInvoiceId ?? null;
  }

  // SC3d-3 — the provider schedule of the event subscription's SCHEDULED
  // change (null: none).
  private async scheduledPlanChange(
    verified: VerifiedBillingProviderEvent,
  ): Promise<string | null> {
    if (verified.externalSubscriptionId === null) return null;
    const scheduled = await this.prisma.billingPlanChange.findFirst({
      where: {
        status: 'SCHEDULED',
        externalScheduleId: { not: null },
        subscription: {
          billingProvider: verified.provider,
          externalSubscriptionId: verified.externalSubscriptionId,
        },
      },
      select: { externalScheduleId: true },
    });
    return scheduled?.externalScheduleId ?? null;
  }

  // --- SC3e-2: complimentary grants (owner decisions D2–D4) ---------------------
  // The subscription side of a grant. The caller (BillingComplimentaryService)
  // verifies the provider first; these only write our records, in the
  // caller's transaction, with their history.

  // A business becomes COMPLIMENTARY on the grant's plan version: no billing
  // state at all (the COMPLIMENTARY invariant — its provider identity and
  // trial are kept on the grant, to be restored). A BILLING suspension is
  // lifted (with enforcement on); nothing else ever is.
  async startComplimentary(
    tx: Tx,
    grant: { id: string; subscriptionId: string; planVersionId: string },
    origin: {
      source: 'OPERATOR' | 'BILLING_PROVIDER' | 'SYSTEM';
      billingProviderEventId: string | null;
      actorPlatformOperatorId: string | null;
    },
  ): Promise<void> {
    const subscription = await this.load(tx, grant.subscriptionId);
    if (subscription.billingMode !== 'BILLED') {
      throw new ConcurrentBillingChange('NOT_BILLED');
    }
    const { count } = await tx.tenantSubscription.updateMany({
      where: {
        id: subscription.id,
        billingStateVersion: subscription.billingStateVersion,
      },
      data: {
        billingMode: 'COMPLIMENTARY',
        billingProvider: null,
        externalCustomerId: null,
        externalSubscriptionId: null,
        status: 'ACTIVE',
        planVersionId: grant.planVersionId,
        planPriceId: null,
        recurringPaymentAuthorizedAt: null,
        trialStartedAt: null,
        trialEndsAt: null,
        trialRequiresPaymentMethod: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        pastDueAt: null,
        graceEndsAt: null,
        recoveryEndsAt: null,
        graceExceptionEndsAt: null,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        pendingChangeKind: null,
        pendingPlanVersionId: null,
        pendingPlanPriceId: null,
        pendingChangeReference: null,
        pendingEffectiveAt: null,
        billingStateVersion: { increment: 1 },
      },
    });
    if (count !== 1) throw new ConcurrentBillingChange('CONCURRENT_CHANGE');
    await tx.tenantSubscriptionEvent.create({
      data: {
        subscriptionId: subscription.id,
        type: 'COMPLIMENTARY_STARTED',
        fromStatus: subscription.status,
        toStatus: 'ACTIVE',
        fromPlanVersionId: subscription.planVersionId,
        toPlanVersionId: grant.planVersionId,
        source: origin.source,
        billingProviderEventId: origin.billingProviderEventId,
        actorPlatformOperatorId: origin.actorPlatformOperatorId,
      },
    });
    const next = await this.load(tx, subscription.id);
    await this.enforce(
      tx,
      next,
      toBillingState(next),
      'LIFT_BILLING_SUSPENSION',
      origin,
    );
  }

  // The grant ended (expired or revoked): the business returns to billing
  // exactly as it was billed before — its provider customer, plan and price,
  // and its trial record (one trial, ever). An ended provider subscription
  // comes back CANCELED (restart through a new Checkout); none yet, back to
  // payment setup. Nothing is charged and no provider subscription is
  // reactivated or created.
  async endComplimentary(
    tx: Tx,
    grant: {
      subscriptionId: string;
      previousPlanVersionId: string;
      previousPlanPriceId: string;
      previousBillingProvider: string;
      previousExternalCustomerId: string;
      previousExternalSubscriptionId: string | null;
      previousTrialStartedAt: Date | null;
      previousTrialEndsAt: Date | null;
      previousTrialRequiresPaymentMethod: boolean | null;
    },
    now: Date,
    origin: {
      source: 'OPERATOR' | 'BILLING_PROVIDER' | 'SYSTEM';
      billingProviderEventId: string | null;
      actorPlatformOperatorId: string | null;
    },
  ): Promise<void> {
    const subscription = await this.load(tx, grant.subscriptionId);
    if (subscription.billingMode !== 'COMPLIMENTARY') {
      throw new ConcurrentBillingChange('NOT_COMPLIMENTARY');
    }
    const ended = grant.previousExternalSubscriptionId !== null;
    const { count } = await tx.tenantSubscription.updateMany({
      where: {
        id: subscription.id,
        billingStateVersion: subscription.billingStateVersion,
      },
      data: {
        billingMode: 'BILLED',
        billingProvider: grant.previousBillingProvider,
        externalCustomerId: grant.previousExternalCustomerId,
        externalSubscriptionId: grant.previousExternalSubscriptionId,
        planVersionId: grant.previousPlanVersionId,
        planPriceId: grant.previousPlanPriceId,
        status: ended ? 'CANCELED' : 'ACTIVE',
        canceledAt: ended ? now : null,
        trialStartedAt: grant.previousTrialStartedAt,
        trialEndsAt: grant.previousTrialEndsAt,
        trialRequiresPaymentMethod: grant.previousTrialRequiresPaymentMethod,
        billingStateVersion: { increment: 1 },
      },
    });
    if (count !== 1) throw new ConcurrentBillingChange('CONCURRENT_CHANGE');
    await tx.tenantSubscriptionEvent.create({
      data: {
        subscriptionId: subscription.id,
        type: 'COMPLIMENTARY_ENDED',
        fromStatus: subscription.status,
        toStatus: ended ? 'CANCELED' : 'ACTIVE',
        fromPlanVersionId: subscription.planVersionId,
        toPlanVersionId: grant.previousPlanVersionId,
        planPriceId: grant.previousPlanPriceId,
        source: origin.source,
        billingProviderEventId: origin.billingProviderEventId,
        actorPlatformOperatorId: origin.actorPlatformOperatorId,
      },
    });
  }

  // A complimentary grant was scheduled (the provider cancels the paid
  // subscription at its period end) or withdrawn before it started: the
  // subscription's cancel-at-period-end follows the provider (verified by
  // the caller), with the history.
  async recordComplimentarySchedule(
    tx: Tx,
    subscriptionId: string,
    kind: 'COMPLIMENTARY_SCHEDULED' | 'COMPLIMENTARY_WITHDRAWN',
    cancelAtPeriodEnd: boolean,
    origin: {
      source: 'OPERATOR' | 'BILLING_PROVIDER' | 'SYSTEM';
      billingProviderEventId: string | null;
      actorPlatformOperatorId: string | null;
    },
  ): Promise<void> {
    await this.syncCancelAtPeriodEnd(
      tx,
      subscriptionId,
      cancelAtPeriodEnd,
      origin,
    );
    const current = await this.load(tx, subscriptionId);
    await tx.tenantSubscriptionEvent.create({
      data: {
        subscriptionId,
        type: kind,
        fromStatus: current.status,
        toStatus: current.status,
        source: origin.source,
        billingProviderEventId: origin.billingProviderEventId,
        actorPlatformOperatorId: origin.actorPlatformOperatorId,
      },
    });
  }

  // The subscription's cancel-at-period-end brought in line with what the
  // provider was verified to hold (CANCEL_SCHEDULED / CANCEL_UNDONE).
  async syncCancelAtPeriodEnd(
    tx: Tx,
    subscriptionId: string,
    cancelAtPeriodEnd: boolean,
    origin: {
      source: 'OPERATOR' | 'BILLING_PROVIDER' | 'SYSTEM';
      billingProviderEventId: string | null;
      actorPlatformOperatorId: string | null;
    },
  ): Promise<void> {
    const subscription = await this.load(tx, subscriptionId);
    if (
      subscription.billingMode === 'BILLED' &&
      subscription.cancelAtPeriodEnd !== cancelAtPeriodEnd &&
      subscription.status !== 'CANCELED'
    ) {
      const result = transition(toBillingState(subscription), {
        type: cancelAtPeriodEnd ? 'CANCEL_SCHEDULED' : 'CANCEL_UNDONE',
        at: new Date(),
      });
      if (result.ok && result.changed) {
        await this.write(
          tx,
          subscription,
          result.next,
          subscription.lastBillingEventAt,
        );
        await this.history(tx, subscription.id, result.history, origin);
      }
    }
  }

  // SC3d-3 — a confirmed scheduled change now has its provider schedule
  // (verified by the caller): recorded, and the subscription's pending
  // change set for the effective date. Our records refusing it (another
  // change landed) is reviewed, never guessed.
  async recordScheduleCreated(
    tx: Tx,
    planChangeId: string,
    externalScheduleId: string,
    effectiveAt: Date,
    origin: {
      source: 'OPERATOR' | 'BILLING_PROVIDER' | 'SYSTEM';
      billingProviderEventId: string | null;
      actorPlatformOperatorId: string | null;
    },
  ): Promise<'SCHEDULED' | 'REVIEW'> {
    const change = await tx.billingPlanChange.findUniqueOrThrow({
      where: { id: planChangeId },
    });
    if (change.status !== 'REQUESTED') {
      return change.status === 'SCHEDULED' ? 'SCHEDULED' : 'REVIEW';
    }
    await tx.billingPlanChange.update({
      where: { id: planChangeId },
      data: { externalScheduleId, status: 'SCHEDULED' },
    });
    const subscription = await this.load(tx, change.subscriptionId);
    const result = transition(toBillingState(subscription), {
      type: 'DOWNGRADE_SCHEDULED',
      at: new Date(),
      planVersionId: change.toPlanVersionId,
      planPriceId: change.toPlanPriceId,
      effectiveAt,
    });
    if (!result.ok || !result.changed) {
      await this.markPlanChangeReview(
        tx,
        planChangeId,
        SCHEDULED_CHANGE_DISRUPTED_CASE,
        `Plan change ${planChangeId}: the provider schedule ${externalScheduleId} exists but our subscription refused the scheduled change (${result.ok ? 'NO_CHANGE' : result.reason}). Nothing was released or changed at the provider: the schedule may still switch the price at its date — release it or resolve before then.`,
      );
      return 'REVIEW';
    }
    await this.write(
      tx,
      subscription,
      result.next,
      subscription.lastBillingEventAt,
    );
    await this.history(tx, subscription.id, result.history, origin);
    return 'SCHEDULED';
  }

  // SC3d-3 — the business cancelled its scheduled change (the provider
  // schedule already released): the subscription's pending change is
  // withdrawn, with its history.
  async withdrawScheduledChange(tx: Tx, subscriptionId: string): Promise<void> {
    const subscription = await this.load(tx, subscriptionId);
    const result = transition(toBillingState(subscription), {
      type: 'SCHEDULED_CHANGE_CANCELED',
      at: new Date(),
    });
    if (result.ok && result.changed) {
      await this.write(
        tx,
        subscription,
        result.next,
        subscription.lastBillingEventAt,
      );
      await this.history(tx, subscription.id, result.history, {
        source: 'SYSTEM',
        billingProviderEventId: null,
        actorPlatformOperatorId: null,
      });
    }
  }

  // SC3d-3 — settles a SCHEDULED change against the provider's LIVE view
  // (owner decisions D1/D5):
  //   APPLIED   the provider bills exactly the scheduled price, on a period
  //             that started on (or after) the effective date — applied now,
  //             paid or not (a failed renewal is ordinary delinquency at the
  //             new price);
  //   CANCELED  the subscription ended (or the trial expired): closed;
  //   REVIEW    the schedule is gone, replaced or altered before the switch,
  //             or the switch is overdue: reviewed (the pending change is
  //             withdrawn; NOTHING is recreated at the provider);
  //   WAITING   scheduled as agreed, its date not reached yet.
  async settleScheduledChange(
    tx: Tx,
    planChangeId: string,
    snapshot: ProviderSubscriptionSnapshot,
    schedule: ProviderSchedule | null,
    now: Date,
    origin: {
      source: 'OPERATOR' | 'BILLING_PROVIDER' | 'SYSTEM';
      billingProviderEventId: string | null;
      actorPlatformOperatorId: string | null;
    },
  ): Promise<'APPLIED' | 'CANCELED' | 'REVIEW' | 'WAITING'> {
    const change = await tx.billingPlanChange.findUniqueOrThrow({
      where: { id: planChangeId },
      include: {
        fromPlanPrice: { select: { externalPriceId: true } },
        toPlanPrice: { select: { externalPriceId: true } },
      },
    });
    if (
      change.status !== 'SCHEDULED' ||
      change.nextRecurringStartsAt === null
    ) {
      return change.status === 'APPLIED' ? 'APPLIED' : 'WAITING';
    }
    const effectiveAt = change.nextRecurringStartsAt;
    const subscription = await this.load(tx, change.subscriptionId);
    const ours =
      snapshot.externalSubscriptionId === subscription.externalSubscriptionId &&
      snapshot.externalCustomerId === subscription.externalCustomerId &&
      snapshot.livemode === this.provider.livemode;
    const item = snapshot.items?.length === 1 ? snapshot.items[0] : null;
    const SKEW = 5 * 60 * 1000;
    const switched =
      ours &&
      item !== null &&
      item.quantity === 1 &&
      change.toPlanPrice.externalPriceId !== null &&
      item.externalPriceId === change.toPlanPrice.externalPriceId &&
      snapshot.currentPeriodStart != null &&
      snapshot.currentPeriodStart.getTime() >= effectiveAt.getTime() - SKEW;
    const withdraw = async () => {
      const current = await this.load(tx, subscription.id);
      const result = transition(toBillingState(current), {
        type: 'SCHEDULED_CHANGE_CANCELED',
        at: now,
      });
      if (result.ok && result.changed) {
        await this.write(tx, current, result.next, current.lastBillingEventAt);
        await this.history(tx, current.id, result.history, origin);
      }
    };

    if (switched) {
      const result = transition(toBillingState(subscription), {
        type: 'SCHEDULED_CHANGE_APPLIED',
        at: new Date(
          Math.max(now.getTime(), snapshot.currentPeriodStart!.getTime()),
        ),
        periodStart: snapshot.currentPeriodStart ?? null,
        periodEnd: snapshot.currentPeriodEnd ?? null,
      });
      if (
        !result.ok ||
        !result.changed ||
        result.next.planPriceId !== change.toPlanPriceId ||
        result.next.planVersionId !== change.toPlanVersionId
      ) {
        await this.markPlanChangeReview(
          tx,
          planChangeId,
          SCHEDULED_CHANGE_DISRUPTED_CASE,
          `Plan change ${planChangeId}: the provider switched to the scheduled price but our subscription is not waiting for it (${result.ok ? 'NO_CHANGE' : result.reason}). Not adopted.`,
        );
        return 'REVIEW';
      }
      await this.write(
        tx,
        subscription,
        result.next,
        subscription.lastBillingEventAt,
      );
      await this.history(tx, subscription.id, result.history, origin);
      await tx.billingPlanChange.update({
        where: { id: planChangeId },
        data: { status: 'APPLIED', finishedAt: now },
      });
      return 'APPLIED';
    }

    // The subscription ended (or a trial expired without payment): closed.
    if (
      snapshot.status === 'canceled' ||
      snapshot.status === 'incomplete_expired' ||
      subscription.status === 'CANCELED' ||
      subscription.status === 'TRIAL_EXPIRED'
    ) {
      await withdraw();
      await tx.billingPlanChange.update({
        where: { id: planChangeId },
        data: {
          status: 'CANCELED',
          failureCode: 'SUBSCRIPTION_ENDED',
          finishedAt: now,
        },
      });
      return 'CANCELED';
    }

    // The business cancelled it (marked before the release): its schedule
    // released or gone is that cancellation, not a disruption.
    if (
      change.failureCode === 'CANCEL_REQUESTED' &&
      snapshot.scheduleId !== change.externalScheduleId &&
      (schedule === null || schedule.status === 'released')
    ) {
      await withdraw();
      await tx.billingPlanChange.update({
        where: { id: planChangeId },
        data: { status: 'CANCELED', failureCode: null, finishedAt: now },
      });
      return 'CANCELED';
    }

    const intact =
      ours &&
      snapshot.scheduleId === change.externalScheduleId &&
      schedule !== null &&
      schedule.externalScheduleId === change.externalScheduleId &&
      schedule.externalSubscriptionId === subscription.externalSubscriptionId &&
      (schedule.status === 'active' || schedule.status === 'not_started') &&
      schedule.phases.length >= 2 &&
      schedule.phases[0].externalPriceId ===
        change.fromPlanPrice.externalPriceId &&
      schedule.phases[0].endDate !== null &&
      Math.abs(schedule.phases[0].endDate.getTime() - effectiveAt.getTime()) <=
        SKEW &&
      schedule.phases[1].externalPriceId ===
        change.toPlanPrice.externalPriceId &&
      schedule.phases[1].quantity === 1;
    if (intact && now.getTime() < effectiveAt.getTime() + SWITCH_LAG_MS) {
      return 'WAITING';
    }
    // Removed, replaced or altered outside CENTERIVO — or overdue: never
    // recreated; the pending change is withdrawn and an operator reviews.
    await withdraw();
    await this.markPlanChangeReview(
      tx,
      planChangeId,
      SCHEDULED_CHANGE_DISRUPTED_CASE,
      `Plan change ${planChangeId} (scheduled for ${effectiveAt.toISOString()}): ${
        intact
          ? 'the provider has not switched the subscription yet, past its date'
          : `the provider schedule ${change.externalScheduleId ?? '-'} is ${schedule === null ? 'gone' : `${schedule.status} or altered`} (subscription schedule now ${snapshot.scheduleId ?? 'none'})`
      }. Not recreated; the business keeps its current plan.`,
    );
    return 'REVIEW';
  }

  // SC3d-2 — a confirmed immediate change was sent to the provider: its
  // invoice is recorded and the subscription's pending UPGRADE (waiting for
  // THAT invoice) is set; then it is settled against what the provider says.
  async recordPlanChangeSubmitted(
    tx: Tx,
    planChangeId: string,
    externalInvoiceId: string,
    snapshot: ProviderSubscriptionSnapshot,
    invoice: ProviderInvoice | null,
    origin: {
      source: 'OPERATOR' | 'BILLING_PROVIDER' | 'SYSTEM';
      billingProviderEventId: string | null;
      actorPlatformOperatorId: string | null;
    },
  ): Promise<PlanChangeSettlement> {
    const change = await tx.billingPlanChange.findUniqueOrThrow({
      where: { id: planChangeId },
    });
    if (change.status !== 'REQUESTED') return 'WAITING';
    const subscription = await this.load(tx, change.subscriptionId);
    const result = transition(toBillingState(subscription), {
      type: 'UPGRADE_REQUESTED',
      at: new Date(),
      planVersionId: change.toPlanVersionId,
      planPriceId: change.toPlanPriceId,
      reference: externalInvoiceId,
    });
    await tx.billingPlanChange.update({
      where: { id: planChangeId },
      data: { externalInvoiceId, status: 'AWAITING_PAYMENT' },
    });
    if (!result.ok || !result.changed) {
      // Our record no longer allows the upgrade (another change landed): the
      // provider may still charge for it — reviewed, never guessed.
      await this.markPlanChangeReview(
        tx,
        planChangeId,
        PLAN_CHANGE_UNCERTAIN_CASE,
        `Submitted to the provider but our subscription refused the pending upgrade (${result.ok ? 'NO_CHANGE' : result.reason}).`,
      );
      return 'REVIEW';
    }
    await this.write(
      tx,
      subscription,
      result.next,
      subscription.lastBillingEventAt,
    );
    await this.history(tx, subscription.id, result.history, origin);
    return this.settlePlanChange(tx, planChangeId, snapshot, invoice, origin);
  }

  // SC3d-2 — settles a confirmed immediate change against the provider's LIVE
  // view (owner decisions D1/D2):
  //   APPLIED  the invoice is ours, a subscription-update invoice, PAID, and
  //            the provider now bills exactly the new price: the new plan
  //            applies (a different amount than confirmed is applied AND
  //            reviewed — the money was collected, nothing is pretended);
  //   ABANDONED the provider discarded it (no pending update, the invoice
  //            void / uncollectible, the price unchanged): the business keeps
  //            its plan and standing;
  //   NOT_YET  paid, but the provider has not applied the price yet;
  //   REVIEW   anything that does not add up (a case is opened);
  //   WAITING  still waiting for payment.
  async settlePlanChange(
    tx: Tx,
    planChangeId: string,
    snapshot: ProviderSubscriptionSnapshot,
    invoice: ProviderInvoice | null,
    origin: {
      source: 'OPERATOR' | 'BILLING_PROVIDER' | 'SYSTEM';
      billingProviderEventId: string | null;
      actorPlatformOperatorId: string | null;
    },
  ): Promise<PlanChangeSettlement> {
    const change = await tx.billingPlanChange.findUniqueOrThrow({
      where: { id: planChangeId },
      include: { toPlanPrice: { select: { externalPriceId: true } } },
    });
    if (change.status === 'APPLIED') return 'APPLIED';
    // Already with an operator, and now paid: the collected money is flagged
    // on its own case (never folded into the earlier one).
    if (
      change.status === 'REVIEW' &&
      invoice !== null &&
      invoice.status === 'paid'
    ) {
      await this.openCase(
        tx,
        UPGRADE_PAID_NOT_APPLIED_CASE,
        change.subscriptionId,
        origin.billingProviderEventId,
        planChangeDetail(
          change,
          invoice,
          'Paid while the change was under review.',
        ),
      );
      return 'REVIEW';
    }
    if (
      change.status !== 'AWAITING_PAYMENT' ||
      change.externalInvoiceId === null
    ) {
      return 'WAITING';
    }
    const subscription = await this.load(tx, change.subscriptionId);
    const invoiceIsOurs =
      invoice !== null &&
      invoice.externalInvoiceId === change.externalInvoiceId &&
      invoice.livemode === this.provider.livemode &&
      invoice.externalSubscriptionId === subscription.externalSubscriptionId &&
      (invoice.externalCustomerId === null ||
        invoice.externalCustomerId === subscription.externalCustomerId) &&
      invoice.billingReason === 'subscription_update';
    const ours =
      snapshot.externalSubscriptionId === subscription.externalSubscriptionId &&
      snapshot.externalCustomerId === subscription.externalCustomerId &&
      snapshot.livemode === this.provider.livemode;
    const onTarget =
      ours &&
      change.toPlanPrice.externalPriceId !== null &&
      verifyBilledPrice(snapshot, change.toPlanPrice.externalPriceId).ok;

    if (invoice !== null && invoice.status === 'paid') {
      if (!invoiceIsOurs || !ours) {
        await this.markPlanChangeReview(
          tx,
          planChangeId,
          PLAN_CHANGE_UNCERTAIN_CASE,
          planChangeDetail(
            change,
            invoice,
            'The paid invoice or subscription does not match this change.',
          ),
        );
        return 'REVIEW';
      }
      if (!onTarget) {
        if (snapshot.hasPendingUpdate === true) return 'NOT_YET';
        await this.markPlanChangeReview(
          tx,
          planChangeId,
          UPGRADE_PAID_NOT_APPLIED_CASE,
          planChangeDetail(
            change,
            invoice,
            'Paid, but the provider does not bill the new price.',
          ),
        );
        return 'REVIEW';
      }
      if (invoice.amountPaidMinorUnits <= 0) {
        await this.markPlanChangeReview(
          tx,
          planChangeId,
          PLAN_CHANGE_UNCERTAIN_CASE,
          planChangeDetail(
            change,
            invoice,
            'Applied by the provider without a collected payment.',
          ),
        );
        return 'REVIEW';
      }
      const result = transition(toBillingState(subscription), {
        type: 'PAYMENT_SUCCEEDED',
        at: new Date(),
        reference: change.externalInvoiceId,
        amountMinorUnits: invoice.amountPaidMinorUnits,
        currency: (invoice.currency ?? change.currency).toUpperCase(),
        periodStart: snapshot.currentPeriodStart ?? null,
        periodEnd: snapshot.currentPeriodEnd ?? null,
      });
      const applied =
        result.ok &&
        result.changed &&
        result.next.planPriceId === change.toPlanPriceId &&
        result.next.planVersionId === change.toPlanVersionId;
      if (!applied) {
        await this.markPlanChangeReview(
          tx,
          planChangeId,
          UPGRADE_PAID_NOT_APPLIED_CASE,
          planChangeDetail(
            change,
            invoice,
            'Paid and applied by the provider, but our subscription is not waiting for it.',
          ),
        );
        return 'REVIEW';
      }
      await this.write(
        tx,
        subscription,
        result.next,
        subscription.lastBillingEventAt,
      );
      await this.history(tx, subscription.id, result.history, origin);
      await tx.billingPlanChange.update({
        where: { id: planChangeId },
        data: {
          status: 'APPLIED',
          amountPaidMinorUnits: invoice.amountPaidMinorUnits,
          finishedAt: new Date(),
        },
      });
      // D1 — collected, applied, and the difference reviewed (never
      // presented as refunded).
      if (
        invoice.amountPaidMinorUnits !== change.previewAmountDueMinorUnits ||
        (invoice.currency ?? change.currency).toUpperCase() !== change.currency
      ) {
        await tx.billingReconciliationCase.create({
          data: {
            kind: PLAN_CHANGE_AMOUNT_MISMATCH_CASE,
            subscriptionId: subscription.id,
            billingProviderEventId: origin.billingProviderEventId,
            detail: planChangeDetail(
              change,
              invoice,
              'Paid amount differs from the confirmed preview.',
            ),
          },
        });
      }
      return 'APPLIED';
    }

    // Discarded by the provider: nothing applied and nothing payable.
    if (
      ours &&
      snapshot.hasPendingUpdate === false &&
      !onTarget &&
      invoice !== null &&
      invoiceIsOurs &&
      (invoice.status === 'void' || invoice.status === 'uncollectible')
    ) {
      const result = transition(toBillingState(subscription), {
        type: 'UPGRADE_ABANDONED',
        at: new Date(),
        reference: change.externalInvoiceId,
      });
      if (result.ok && result.changed) {
        await this.write(
          tx,
          subscription,
          result.next,
          subscription.lastBillingEventAt,
        );
        await this.history(tx, subscription.id, result.history, origin);
      }
      await tx.billingPlanChange.update({
        where: { id: planChangeId },
        data: {
          status: 'EXPIRED',
          failureCode: 'PAYMENT_NOT_COMPLETED',
          finishedAt: new Date(),
        },
      });
      return 'ABANDONED';
    }
    // The provider no longer holds the change, yet its invoice is still open:
    // paying it would not apply the plan — reviewed (and no longer offered).
    if (
      ours &&
      snapshot.hasPendingUpdate === false &&
      !onTarget &&
      invoice !== null &&
      invoiceIsOurs &&
      invoice.status === 'open'
    ) {
      await this.markPlanChangeReview(
        tx,
        planChangeId,
        PLAN_CHANGE_UNCERTAIN_CASE,
        planChangeDetail(
          change,
          invoice,
          'The provider dropped the pending change but its invoice is still open.',
        ),
      );
      return 'REVIEW';
    }
    return 'WAITING';
  }

  // SC3d-2 — a change that needs an operator: REVIEW and one OPEN case.
  async markPlanChangeReview(
    tx: Tx,
    planChangeId: string,
    caseKind: string,
    detail: string,
  ): Promise<void> {
    const change = await tx.billingPlanChange.findUniqueOrThrow({
      where: { id: planChangeId },
      select: { status: true, subscriptionId: true },
    });
    if (
      change.status === 'REQUESTED' ||
      change.status === 'AWAITING_PAYMENT' ||
      change.status === 'SCHEDULED'
    ) {
      await tx.billingPlanChange.update({
        where: { id: planChangeId },
        data: { status: 'REVIEW' },
      });
    }
    await this.openCase(
      tx,
      caseKind,
      change.subscriptionId,
      null,
      detail.slice(0, 500),
    );
  }

  // SC3b — something for a platform operator to review (never acts). One
  // OPEN case per subject and kind.
  async openCase(
    tx: Tx,
    kind: string,
    subscriptionId: string | null,
    billingProviderEventId: string | null,
    detail: string | null = null,
  ): Promise<void> {
    const existing = await tx.billingReconciliationCase.findFirst({
      where: {
        status: 'OPEN',
        kind,
        ...(subscriptionId !== null
          ? { subscriptionId }
          : { billingProviderEventId }),
      },
      select: { id: true },
    });
    if (existing) return;
    await tx.billingReconciliationCase.create({
      data: { kind, subscriptionId, billingProviderEventId, detail },
    });
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
      const claimKey = trialClaimKey(ownerEmail, trialClaimSecret());
      // SC3b — another business of the same owner holds this claim in an
      // open Checkout: its trial is honoured, never pre-empted here.
      const heldElsewhere = await tx.billingCheckoutSession.findFirst({
        where: {
          trialClaimKey: claimKey,
          status: 'OPEN',
          subscriptionId: { not: subscription.id },
        },
        select: { id: true },
      });
      if (heldElsewhere) {
        throw new BillingLifecycleError('TRIAL_ALREADY_USED');
      }
      try {
        await tx.billingTrialClaim.create({
          data: { subscriptionId: subscription.id, claimKey },
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
      {
        type:
          | 'GRACE_EXPIRED'
          | 'RECOVERY_EXPIRED'
          | 'GRACE_EXCEPTION_EXPIRED'
          | 'UPGRADE_REQUESTED'
          | 'DOWNGRADE_SCHEDULED';
      }
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
      const origin = {
        source: actorPlatformOperatorId
          ? ('OPERATOR' as const)
          : ('SYSTEM' as const),
        billingProviderEventId: null,
        actorPlatformOperatorId,
      };
      await this.history(tx, subscription.id, result.history, origin);
      await this.enforce(
        tx,
        subscription,
        result.next,
        result.suspension,
        origin,
      );
      return { state: result.next, suspension: result.suspension };
    });
  }

  // SC3c-1 — applies a billing change's effect on the BUSINESS, in the same
  // transaction as the change itself (BILLING_ENFORCEMENT_ENABLED only).
  // decideSuspension never overrides an administrative decision: billing
  // suspends only an ACTIVE business (reason BILLING) and lifts only a
  // BILLING suspension — a SECURITY or REQUESTED suspension is never
  // touched, by a suspension or by a payment. Non-billed and Founding
  // businesses (Mocha House, Tenant #1, is Founding) are never suspended for
  // billing:
  // such an effect is handed to review instead. Each applied change is
  // recorded in the subscription history.
  private async enforce(
    tx: Tx,
    subscription: SubscriptionRow,
    next: BillingState,
    effect: SuspensionEffect,
    origin: {
      source: 'OPERATOR' | 'BILLING_PROVIDER' | 'SYSTEM';
      billingProviderEventId: string | null;
      actorPlatformOperatorId: string | null;
    },
  ): Promise<void> {
    if (effect === 'NONE' || !billingEnforcementEnabled()) return;
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: subscription.subscriberTenantId },
      select: { id: true, status: true, suspensionReason: true },
    });
    if (effect === 'SUSPEND_FOR_BILLING') {
      const plan = await tx.subscriptionPlanVersion.findUniqueOrThrow({
        where: { id: subscription.planVersionId },
        select: { plan: { select: { key: true } } },
      });
      if (
        subscription.billingMode !== 'BILLED' ||
        plan.plan.key === 'founding'
      ) {
        await this.openCase(
          tx,
          'SUSPENSION_EXEMPT',
          subscription.id,
          origin.billingProviderEventId,
        );
        return;
      }
    }
    const action = decideSuspension(effect, tenant);
    if (action === 'NONE') return;
    if (action === 'LIFT_BILLING') {
      const latest = await tx.tenantSubscriptionEvent.findFirst({
        where: {
          subscriptionId: subscription.id,
          type: { in: ['BILLING_SUSPENDED', 'BILLING_SUSPENSION_LIFTED'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { type: true },
      });
      if (latest?.type !== 'BILLING_SUSPENDED') return;
    }
    // Compare-and-set: only the state decideSuspension saw is changed.
    const { count } =
      action === 'SUSPEND_BILLING'
        ? await tx.tenant.updateMany({
            where: { id: tenant.id, status: 'ACTIVE' },
            data: { status: 'SUSPENDED', suspensionReason: 'BILLING' },
          })
        : await tx.tenant.updateMany({
            where: {
              id: tenant.id,
              status: 'SUSPENDED',
              suspensionReason: 'BILLING',
            },
            data: { status: 'ACTIVE', suspensionReason: null },
          });
    if (count !== 1) return;
    const recorded = await tx.tenantSubscriptionEvent.create({
      select: { id: true },
      data: {
        subscriptionId: subscription.id,
        type:
          action === 'SUSPEND_BILLING'
            ? 'BILLING_SUSPENDED'
            : 'BILLING_SUSPENSION_LIFTED',
        fromStatus: subscription.status,
        toStatus: next.status,
        source: origin.source,
        billingProviderEventId: origin.billingProviderEventId,
        actorPlatformOperatorId: origin.actorPlatformOperatorId,
      },
    });
    // SC3c-3 — the business is told (deduplicated by this history entry).
    await enqueueBillingNotice(tx, {
      subscriptionId: subscription.id,
      kind:
        action === 'SUSPEND_BILLING' ? 'BILLING_SUSPENDED' : 'ACCESS_RESTORED',
      subject: recorded.id,
      deadline: action === 'LIFT_BILLING' ? next.graceExceptionEndsAt : null,
      temporary: action === 'LIFT_BILLING' && next.status === 'UNPAID',
    });
  }

  // SC3c-1 — the subscriptions whose grace period or trial recovery window
  // is over (the enforcement sweep's work list). Oldest deadline first.
  async dueForEnforcement(
    now: Date,
    limit: number,
  ): Promise<
    {
      subscriptionId: string;
      event: 'GRACE_EXPIRED' | 'RECOVERY_EXPIRED' | 'GRACE_EXCEPTION_EXPIRED';
    }[]
  > {
    const [grace, recovery, exceptions] = await Promise.all([
      this.prisma.tenantSubscription.findMany({
        where: {
          billingMode: 'BILLED',
          status: 'PAST_DUE',
          graceEndsAt: { lte: now },
        },
        orderBy: { graceEndsAt: 'asc' },
        take: limit,
        select: { id: true },
      }),
      this.prisma.tenantSubscription.findMany({
        where: {
          billingMode: 'BILLED',
          status: 'TRIAL_EXPIRED',
          recoveryEndsAt: { lte: now },
        },
        orderBy: { recoveryEndsAt: 'asc' },
        take: limit,
        select: { id: true },
      }),
      // SC3c-3 — an UNPAID subscription's grace exception is over.
      this.prisma.tenantSubscription.findMany({
        where: {
          billingMode: 'BILLED',
          status: 'UNPAID',
          graceExceptionEndsAt: { lte: now },
        },
        orderBy: { graceExceptionEndsAt: 'asc' },
        take: limit,
        select: { id: true },
      }),
    ]);
    return [
      ...grace.map((row) => ({
        subscriptionId: row.id,
        event: 'GRACE_EXPIRED' as const,
      })),
      ...recovery.map((row) => ({
        subscriptionId: row.id,
        event: 'RECOVERY_EXPIRED' as const,
      })),
      ...exceptions.map((row) => ({
        subscriptionId: row.id,
        event: 'GRACE_EXCEPTION_EXPIRED' as const,
      })),
    ];
  }

  // SC3c-3 — reminders before a deadline (the enforcement sweep queues
  // them): a grace period or grace exception ending within 3 days, a trial
  // recovery window ending within 1 day. Deduplicated by the deadline, so
  // repeated sweeps queue each once (a NEW deadline — an extension — gets
  // its own reminder).
  async queueReminders(now: Date, limit: number): Promise<number> {
    const graceUntil = new Date(now.getTime() + GRACE_REMINDER_MS);
    const recoveryUntil = new Date(now.getTime() + RECOVERY_REMINDER_MS);
    const [grace, exceptions, recovery] = await Promise.all([
      this.prisma.tenantSubscription.findMany({
        where: {
          billingMode: 'BILLED',
          status: 'PAST_DUE',
          graceEndsAt: { gt: now, lte: graceUntil },
        },
        take: limit,
        select: { id: true, graceEndsAt: true },
      }),
      this.prisma.tenantSubscription.findMany({
        where: {
          billingMode: 'BILLED',
          status: 'UNPAID',
          graceExceptionEndsAt: { gt: now, lte: graceUntil },
        },
        take: limit,
        select: { id: true, graceExceptionEndsAt: true },
      }),
      this.prisma.tenantSubscription.findMany({
        where: {
          billingMode: 'BILLED',
          status: 'TRIAL_EXPIRED',
          recoveryEndsAt: { gt: now, lte: recoveryUntil },
        },
        take: limit,
        select: { id: true, recoveryEndsAt: true },
      }),
    ]);
    const reminders = [
      ...grace.map((row) => ({
        id: row.id,
        kind: 'GRACE_ENDING' as const,
        deadline: row.graceEndsAt!,
      })),
      ...exceptions.map((row) => ({
        id: row.id,
        kind: 'GRACE_ENDING' as const,
        deadline: row.graceExceptionEndsAt!,
      })),
      ...recovery.map((row) => ({
        id: row.id,
        kind: 'TRIAL_RECOVERY_ENDING' as const,
        deadline: row.recoveryEndsAt!,
      })),
    ];
    for (const reminder of reminders) {
      await this.prisma.$transaction((tx) =>
        enqueueBillingNotice(tx, {
          subscriptionId: reminder.id,
          kind: reminder.kind,
          subject: reminder.deadline.toISOString(),
          deadline: reminder.deadline,
          now,
        }),
      );
    }
    return reminders.length;
  }

  // SC3c-3 — an operator extends a PAST_DUE grace period, or grants (or
  // extends) an UNPAID subscription's grace exception, by `days` (1-14),
  // within 60 days per unpaid episode (the episode starts at its first
  // failed payment). The caller has verified LIVE that the provider's
  // subscription can still be recovered (never inside this transaction).
  // One serializable transaction: the subscription change (compare-and-set),
  // its history, the append-only extension record, the platform audit and
  // the effect on the business (an UNPAID exception lifts ONLY a BILLING
  // suspension — never SECURITY or an administrative one). Nothing is paid,
  // charged, refunded or changed at the provider; the debt stays.
  async extendGrace(
    subscriptionId: string,
    expected: { externalSubscriptionId: string; status: 'PAST_DUE' | 'UNPAID' },
    input: { days: number; reason: string },
    actorPlatformOperatorId: string,
    requestReference: string | null,
    now: Date = new Date(),
  ): Promise<void> {
    await runSerializable(this.prisma, async (tx) => {
      const subscription = await this.load(tx, subscriptionId);
      if (
        subscription.billingMode !== 'BILLED' ||
        subscription.status !== expected.status ||
        subscription.externalSubscriptionId !==
          expected.externalSubscriptionId ||
        subscription.pastDueAt === null
      ) {
        throw new BillingLifecycleError('NOT_EXTENDABLE');
      }
      const episodeStartedAt = subscription.pastDueAt;
      const used = await tx.billingGraceExtension.aggregate({
        where: { subscriptionId, episodeStartedAt },
        _sum: { days: true },
      });
      if (
        (used._sum.days ?? 0) + input.days >
        GRACE_EXTENSION_EPISODE_MAX_DAYS
      ) {
        throw new BillingLifecycleError('EXTENSION_LIMIT');
      }
      const state = toBillingState(subscription);
      const current =
        subscription.status === 'PAST_DUE'
          ? subscription.graceEndsAt
          : subscription.graceExceptionEndsAt;
      const previousEndsAt = current !== null && current > now ? current : now;
      const endsAt = new Date(previousEndsAt.getTime() + input.days * DAY_MS);
      const result = transition(
        state,
        subscription.status === 'PAST_DUE'
          ? { type: 'GRACE_EXTENDED', at: now, endsAt }
          : { type: 'GRACE_EXCEPTION_GRANTED', at: now, endsAt },
      );
      if (!result.ok) {
        throw new BillingLifecycleError(
          result.reason === 'INVALID_EXTENSION'
            ? 'EXTENSION_LIMIT'
            : 'NOT_EXTENDABLE',
        );
      }
      await this.write(
        tx,
        subscription,
        result.next,
        subscription.lastBillingEventAt,
      );
      const origin = {
        source: 'OPERATOR' as const,
        billingProviderEventId: null,
        actorPlatformOperatorId,
      };
      await this.history(tx, subscription.id, result.history, origin);
      await tx.billingGraceExtension.create({
        data: {
          subscriptionId,
          kind:
            subscription.status === 'PAST_DUE'
              ? 'GRACE_EXTENDED'
              : 'GRACE_EXCEPTION',
          episodeStartedAt,
          days: input.days,
          previousEndsAt,
          newEndsAt: endsAt,
          reason: input.reason,
          actorPlatformOperatorId,
        },
      });
      await tx.platformAuditEvent.create({
        data: {
          action: PLATFORM_AUDIT_ACTIONS.billingGraceExtended,
          outcome: 'SUCCEEDED',
          reasonCode:
            subscription.status === 'PAST_DUE'
              ? 'GRACE_EXTENDED'
              : 'GRACE_EXCEPTION',
          actorPlatformOperatorId,
          targetType: 'tenant',
          targetId: subscription.subscriberTenantId,
          requestReference,
        },
      });
      await this.enforce(
        tx,
        subscription,
        result.next,
        result.suspension,
        origin,
      );
    });
  }

  // SC3c-3 — what follows from a subscription change, in its transaction:
  // the business's billing notices, and a review case when the provider
  // ended a subscription during an operator's extension or exception.
  private async afterChange(
    tx: Tx,
    current: SubscriptionRow,
    next: BillingState,
    linked: string | undefined,
  ): Promise<void> {
    if (
      current.status !== 'PAST_DUE' &&
      next.status === 'PAST_DUE' &&
      next.pastDueAt
    ) {
      await enqueueBillingNotice(tx, {
        subscriptionId: current.id,
        kind: 'PAYMENT_FAILED',
        subject: next.pastDueAt.toISOString(),
        deadline: next.graceEndsAt,
      });
    }
    if (current.status !== 'TRIAL_EXPIRED' && next.status === 'TRIAL_EXPIRED') {
      await enqueueBillingNotice(tx, {
        subscriptionId: current.id,
        kind: 'TRIAL_EXPIRED',
        subject: (next.recoveryEndsAt ?? new Date()).toISOString(),
        deadline: next.recoveryEndsAt,
      });
    }
    if (
      linked !== undefined &&
      (current.status === 'TRIAL_EXPIRED' || current.status === 'CANCELED') &&
      next.status === 'ACTIVE'
    ) {
      await enqueueBillingNotice(tx, {
        subscriptionId: current.id,
        kind: 'RESTART_CONFIRMED',
        subject: linked,
      });
    }
    if (current.status !== 'CANCELED' && next.status === 'CANCELED') {
      const extended =
        current.graceExceptionEndsAt !== null ||
        (current.status === 'PAST_DUE' &&
          current.pastDueAt !== null &&
          (await tx.billingGraceExtension.count({
            where: {
              subscriptionId: current.id,
              episodeStartedAt: current.pastDueAt,
            },
          })) > 0);
      if (extended) {
        await this.openCase(
          tx,
          EXTENSION_ENDED_BY_PROVIDER_CASE,
          current.id,
          null,
          `The provider ended the subscription while it was ${current.status} under an operator grace ${
            current.graceExceptionEndsAt !== null ? 'exception' : 'extension'
          }. Not paid; the extension's access has ended; nothing was changed at the provider.`,
        );
      }
    }
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
    link: { externalSubscriptionId?: string } = {},
  ): Promise<void> {
    const { count } = await tx.tenantSubscription.updateMany({
      where: {
        id: current.id,
        billingStateVersion: current.billingStateVersion,
      },
      data: {
        ...stateColumns(next),
        ...link,
        lastBillingEventAt,
        billingStateVersion: { increment: 1 },
      },
    });
    if (count !== 1) throw new ConcurrentBillingChange('CONCURRENT_CHANGE');
    await this.afterChange(tx, current, next, link.externalSubscriptionId);
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
