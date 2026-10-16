// SC3a — the CENTERIVO SaaS subscription billing lifecycle, as PURE
// functions (no database, no provider, no clock). Every billing change —
// from the billing provider, the system (grace expiry) or a platform
// operator — goes through `transition`, which either refuses it or returns
// the next state, the history to record and the effect on the business's
// suspension. It never decides about money movement itself: it only says
// whether automatic charging is allowed (`mayChargeAutomatically`).
//
// Owner decisions encoded here:
//   E3  a COMPLIMENTARY subscription (Founding) is never billed: every
//       billing event is refused.
//   E5  nothing is charged without authorization for recurring payment; a
//       trial that ends without it expires (TRIAL_EXPIRED) and starts no
//       charge.
//   E6  a failed payment starts ONE grace period (full access), fixed at the
//       first failure and never extended by later failures; when it expires
//       the subscription is UNPAID and the business is suspended for
//       billing. Only a confirmed payment lifts a BILLING suspension, and
//       nothing here ever lifts any other suspension (decideSuspension).
//   E7  cancellation takes effect at the end of the period; CANCELED is a
//       billing state and NEVER a tenant suspension.
//   E8  an upgrade is pending until ITS payment is confirmed (then the new
//       plan's modules apply); a downgrade applies at the period boundary.

export type BillingStatus =
  'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'UNPAID' | 'TRIAL_EXPIRED' | 'CANCELED';

export type BillingMode = 'COMPLIMENTARY' | 'BILLED';

export interface PendingPlanChange {
  kind: 'UPGRADE' | 'DOWNGRADE';
  planVersionId: string;
  planPriceId: string | null;
  // UPGRADE: the provider payment reference that must succeed.
  reference: string | null;
  // DOWNGRADE: when it takes effect (the end of the current period).
  effectiveAt: Date | null;
}

export interface BillingState {
  billingMode: BillingMode;
  status: BillingStatus;
  planVersionId: string;
  planPriceId: string | null;
  recurringPaymentAuthorizedAt: Date | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  trialRequiresPaymentMethod: boolean | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  pastDueAt: Date | null;
  graceEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  pending: PendingPlanChange | null;
}

// Normalized events (provider-neutral). `at` is when it happened.
export type BillingEvent =
  // Operator/system: a BILLED subscription starts its one trial.
  | {
      type: 'TRIAL_STARTED';
      at: Date;
      trialDays: number;
      requiresPaymentMethod: boolean;
    }
  // Provider: the business authorized recurring automatic payment.
  | { type: 'PAYMENT_AUTHORIZED'; at: Date }
  // Provider: a payment was confirmed. `reference` identifies what was paid
  // (an invoice); a renewal carries the period it paid for.
  | {
      type: 'PAYMENT_SUCCEEDED';
      at: Date;
      reference: string;
      // What was actually collected. A zero-amount payment (e.g. a $0 trial
      // invoice) is proof of nothing: it never activates, recovers or
      // upgrades a subscription.
      amountMinorUnits: number;
      currency: string;
      periodStart: Date | null;
      periodEnd: Date | null;
    }
  // Provider: a payment attempt failed. The grace length comes from the
  // billing policy in force when the delinquency starts.
  | {
      type: 'PAYMENT_FAILED';
      at: Date;
      reference: string;
      gracePeriodDays: number;
    }
  // Provider: the trial period is over.
  | { type: 'TRIAL_ENDED'; at: Date }
  // System: the grace period is over.
  | { type: 'GRACE_EXPIRED'; at: Date }
  | { type: 'CANCEL_SCHEDULED'; at: Date }
  | { type: 'CANCEL_UNDONE'; at: Date }
  // Provider: the subscription ended (after a scheduled cancellation).
  | { type: 'SUBSCRIPTION_ENDED'; at: Date }
  // Operator: request an upgrade; it waits for payment `reference`.
  | {
      type: 'UPGRADE_REQUESTED';
      at: Date;
      planVersionId: string;
      planPriceId: string | null;
      reference: string;
    }
  // Operator: schedule a downgrade for `effectiveAt` (the period end).
  | {
      type: 'DOWNGRADE_SCHEDULED';
      at: Date;
      planVersionId: string;
      planPriceId: string | null;
      effectiveAt: Date;
    };

export type BillingEventType = BillingEvent['type'];

// What to record in TenantSubscriptionEvent.
export interface BillingHistoryEntry {
  type:
    | 'TRIAL_STARTED'
    | 'PAYMENT_AUTHORIZED'
    | 'PAYMENT_SUCCEEDED'
    | 'PAYMENT_FAILED'
    | 'GRACE_EXPIRED'
    | 'TRIAL_EXPIRED'
    | 'CANCEL_SCHEDULED'
    | 'CANCEL_UNDONE'
    | 'CANCELED'
    | 'PLAN_CHANGE_PENDING'
    | 'PLAN_CHANGE_APPLIED'
    | 'PLAN_CHANGE_ABANDONED';
  fromStatus: BillingStatus;
  toStatus: BillingStatus;
  fromPlanVersionId: string | null;
  toPlanVersionId: string | null;
  planPriceId: string | null;
}

// The business-level consequence, decided against the tenant's CURRENT
// suspension by decideSuspension (never applied blindly).
export type SuspensionEffect =
  'NONE' | 'SUSPEND_FOR_BILLING' | 'LIFT_BILLING_SUSPENSION';

export type RefusalReason =
  | 'COMPLIMENTARY'
  | 'CANCELED'
  | 'NOT_IN_TRIAL'
  | 'TRIAL_ALREADY_USED'
  | 'INVALID_TRIAL'
  | 'NOT_PAST_DUE'
  | 'GRACE_NOT_OVER'
  | 'NOT_AUTHORIZED'
  | 'NOTHING_TO_CANCEL'
  | 'CHANGE_PENDING'
  | 'SAME_PLAN'
  | 'INVALID_EFFECTIVE_DATE'
  | 'NOT_CHANGEABLE';

export type TransitionResult =
  | {
      ok: true;
      // false: a valid event that changes nothing (e.g. a repeated
      // authorization) — recorded as IGNORED, never re-applied.
      changed: boolean;
      next: BillingState;
      history: BillingHistoryEntry[];
      suspension: SuspensionEffect;
    }
  | { ok: false; reason: RefusalReason };

const DAY_MS = 24 * 60 * 60 * 1000;

function refuse(reason: RefusalReason): TransitionResult {
  return { ok: false, reason };
}

function unchanged(state: BillingState): TransitionResult {
  return {
    ok: true,
    changed: false,
    next: state,
    history: [],
    suspension: 'NONE',
  };
}

function entry(
  type: BillingHistoryEntry['type'],
  from: BillingState,
  to: BillingState,
  plan?: { from: string | null; to: string | null; price: string | null },
): BillingHistoryEntry {
  return {
    type,
    fromStatus: from.status,
    toStatus: to.status,
    fromPlanVersionId: plan?.from ?? null,
    toPlanVersionId: plan?.to ?? null,
    planPriceId: plan?.price ?? null,
  };
}

function changed(
  from: BillingState,
  next: BillingState,
  history: BillingHistoryEntry[],
  suspension: SuspensionEffect = 'NONE',
): TransitionResult {
  return { ok: true, changed: true, next, history, suspension };
}

// Nothing is ever charged automatically without recurring-payment
// authorization, and never for a COMPLIMENTARY or ended subscription.
export function mayChargeAutomatically(state: BillingState): boolean {
  return (
    state.billingMode === 'BILLED' &&
    state.recurringPaymentAuthorizedAt !== null &&
    state.status !== 'CANCELED'
  );
}

// Full access, or only what is needed to recover billing. COMPLIMENTARY and
// any subscription in good standing (or within its grace period) have full
// access. Enforcement is SC3c; this is the single decision it will use.
export type BillingAccess = 'FULL' | 'BILLING_RECOVERY_ONLY';

export function billingAccess(state: BillingState): BillingAccess {
  if (state.billingMode === 'COMPLIMENTARY') return 'FULL';
  switch (state.status) {
    case 'ACTIVE':
    case 'TRIALING':
    case 'PAST_DUE':
      return 'FULL';
    case 'UNPAID':
    case 'TRIAL_EXPIRED':
    case 'CANCELED':
      return 'BILLING_RECOVERY_ONLY';
  }
}

export function transition(
  state: BillingState,
  event: BillingEvent,
): TransitionResult {
  if (state.billingMode === 'COMPLIMENTARY') return refuse('COMPLIMENTARY');
  if (state.status === 'CANCELED') return refuse('CANCELED');

  switch (event.type) {
    case 'TRIAL_STARTED': {
      // One trial per subscription, before it was ever paid for.
      if (state.trialStartedAt !== null) return refuse('TRIAL_ALREADY_USED');
      if (state.status !== 'ACTIVE' || state.currentPeriodStart !== null) {
        return refuse('NOT_CHANGEABLE');
      }
      if (
        !Number.isInteger(event.trialDays) ||
        event.trialDays < 1 ||
        event.trialDays > 90
      ) {
        return refuse('INVALID_TRIAL');
      }
      // A trial that requires a payment method only starts once recurring
      // payment is authorized.
      if (
        event.requiresPaymentMethod &&
        state.recurringPaymentAuthorizedAt === null
      ) {
        return refuse('NOT_AUTHORIZED');
      }
      const next: BillingState = {
        ...state,
        status: 'TRIALING',
        trialStartedAt: event.at,
        trialEndsAt: new Date(event.at.getTime() + event.trialDays * DAY_MS),
        trialRequiresPaymentMethod: event.requiresPaymentMethod,
      };
      return changed(state, next, [entry('TRIAL_STARTED', state, next)]);
    }

    case 'PAYMENT_AUTHORIZED': {
      if (state.recurringPaymentAuthorizedAt !== null) return unchanged(state);
      const next = { ...state, recurringPaymentAuthorizedAt: event.at };
      return changed(state, next, [entry('PAYMENT_AUTHORIZED', state, next)]);
    }

    case 'PAYMENT_SUCCEEDED': {
      if (
        !Number.isInteger(event.amountMinorUnits) ||
        event.amountMinorUnits <= 0
      ) {
        return unchanged(state);
      }
      // The payment for a pending UPGRADE: only now do the new plan's
      // modules apply. Status and period are unchanged.
      if (
        state.pending?.kind === 'UPGRADE' &&
        state.pending.reference === event.reference
      ) {
        const next: BillingState = {
          ...state,
          planVersionId: state.pending.planVersionId,
          planPriceId: state.pending.planPriceId ?? state.planPriceId,
          pending: null,
        };
        return changed(state, next, [
          entry('PLAN_CHANGE_APPLIED', state, next, {
            from: state.planVersionId,
            to: next.planVersionId,
            price: state.pending.planPriceId,
          }),
        ]);
      }
      // A regular payment (first payment, renewal, recovery).
      // The period only moves forward: a malformed period, or one older
      // than the current (a late payment of an old invoice), never replaces
      // it.
      const newerPeriod =
        event.periodStart !== null &&
        event.periodEnd !== null &&
        event.periodEnd > event.periodStart &&
        (state.currentPeriodEnd === null ||
          event.periodEnd > state.currentPeriodEnd);
      let next: BillingState = {
        ...state,
        status: 'ACTIVE',
        pastDueAt: null,
        graceEndsAt: null,
        currentPeriodStart: newerPeriod
          ? event.periodStart
          : state.currentPeriodStart,
        currentPeriodEnd: newerPeriod
          ? event.periodEnd
          : state.currentPeriodEnd,
      };
      const history = [entry('PAYMENT_SUCCEEDED', state, next)];
      // A scheduled downgrade takes effect with the first period that
      // starts on or after its effective date.
      if (
        state.pending?.kind === 'DOWNGRADE' &&
        state.pending.effectiveAt !== null &&
        newerPeriod &&
        event.periodStart !== null &&
        event.periodStart >= state.pending.effectiveAt
      ) {
        const applied: BillingState = {
          ...next,
          planVersionId: state.pending.planVersionId,
          planPriceId: state.pending.planPriceId ?? next.planPriceId,
          pending: null,
        };
        history.push(
          entry('PLAN_CHANGE_APPLIED', next, applied, {
            from: state.planVersionId,
            to: applied.planVersionId,
            price: state.pending.planPriceId,
          }),
        );
        next = applied;
      }
      const recovered =
        state.status === 'UNPAID' || state.status === 'TRIAL_EXPIRED';
      return changed(
        state,
        next,
        history,
        recovered ? 'LIFT_BILLING_SUSPENSION' : 'NONE',
      );
    }

    case 'PAYMENT_FAILED': {
      // The pending upgrade's own payment failed: the upgrade is abandoned
      // and the subscription keeps its plan and standing.
      if (
        state.pending?.kind === 'UPGRADE' &&
        state.pending.reference === event.reference
      ) {
        const next = { ...state, pending: null };
        return changed(state, next, [
          entry('PLAN_CHANGE_ABANDONED', state, next, {
            from: state.planVersionId,
            to: state.pending.planVersionId,
            price: state.pending.planPriceId,
          }),
        ]);
      }
      if (state.recurringPaymentAuthorizedAt === null) {
        // There was no authorization to charge against: never treated as
        // a delinquency of the business.
        return refuse('NOT_AUTHORIZED');
      }
      if (state.status === 'PAST_DUE' || state.status === 'UNPAID') {
        // A retry failed: recorded, but the grace period is NOT extended.
        return changed(state, state, [entry('PAYMENT_FAILED', state, state)]);
      }
      if (state.status === 'TRIAL_EXPIRED') {
        return changed(state, state, [entry('PAYMENT_FAILED', state, state)]);
      }
      if (
        !Number.isInteger(event.gracePeriodDays) ||
        event.gracePeriodDays < 1 ||
        event.gracePeriodDays > 60
      ) {
        return refuse('NOT_CHANGEABLE');
      }
      const next: BillingState = {
        ...state,
        status: 'PAST_DUE',
        pastDueAt: event.at,
        graceEndsAt: new Date(
          event.at.getTime() + event.gracePeriodDays * DAY_MS,
        ),
      };
      return changed(state, next, [entry('PAYMENT_FAILED', state, next)]);
    }

    case 'TRIAL_ENDED': {
      if (state.status !== 'TRIALING') return refuse('NOT_IN_TRIAL');
      if (state.recurringPaymentAuthorizedAt !== null) {
        // Authorized: the first invoice decides (paid -> ACTIVE, failed ->
        // PAST_DUE). Nothing changes yet.
        return unchanged(state);
      }
      // No authorization: the trial expires and NOTHING is charged.
      const next: BillingState = { ...state, status: 'TRIAL_EXPIRED' };
      return changed(
        state,
        next,
        [entry('TRIAL_EXPIRED', state, next)],
        'SUSPEND_FOR_BILLING',
      );
    }

    case 'GRACE_EXPIRED': {
      if (state.status !== 'PAST_DUE' || state.graceEndsAt === null) {
        return refuse('NOT_PAST_DUE');
      }
      if (event.at < state.graceEndsAt) return refuse('GRACE_NOT_OVER');
      const next: BillingState = { ...state, status: 'UNPAID' };
      return changed(
        state,
        next,
        [entry('GRACE_EXPIRED', state, next)],
        'SUSPEND_FOR_BILLING',
      );
    }

    case 'CANCEL_SCHEDULED': {
      if (state.cancelAtPeriodEnd) return unchanged(state);
      const next = { ...state, cancelAtPeriodEnd: true };
      return changed(state, next, [entry('CANCEL_SCHEDULED', state, next)]);
    }

    case 'CANCEL_UNDONE': {
      if (!state.cancelAtPeriodEnd) return refuse('NOTHING_TO_CANCEL');
      const next = { ...state, cancelAtPeriodEnd: false };
      return changed(state, next, [entry('CANCEL_UNDONE', state, next)]);
    }

    case 'SUBSCRIPTION_ENDED': {
      // The billing ends. The business is NOT suspended by this (E7): its
      // identity, owner access, history and data stay; access is decided by
      // billingAccess (SC3c).
      const next: BillingState = {
        ...state,
        status: 'CANCELED',
        canceledAt: event.at,
        cancelAtPeriodEnd: false,
        pending: null,
      };
      return changed(state, next, [entry('CANCELED', state, next)]);
    }

    case 'UPGRADE_REQUESTED': {
      if (state.pending !== null) return refuse('CHANGE_PENDING');
      if (state.status !== 'ACTIVE') return refuse('NOT_CHANGEABLE');
      if (event.planVersionId === state.planVersionId) {
        return refuse('SAME_PLAN');
      }
      const next: BillingState = {
        ...state,
        pending: {
          kind: 'UPGRADE',
          planVersionId: event.planVersionId,
          planPriceId: event.planPriceId,
          reference: event.reference,
          effectiveAt: null,
        },
      };
      return changed(state, next, [
        entry('PLAN_CHANGE_PENDING', state, next, {
          from: state.planVersionId,
          to: event.planVersionId,
          price: event.planPriceId,
        }),
      ]);
    }

    case 'DOWNGRADE_SCHEDULED': {
      if (state.pending !== null) return refuse('CHANGE_PENDING');
      if (state.status !== 'ACTIVE' && state.status !== 'TRIALING') {
        return refuse('NOT_CHANGEABLE');
      }
      if (event.planVersionId === state.planVersionId) {
        return refuse('SAME_PLAN');
      }
      if (event.effectiveAt <= event.at) {
        return refuse('INVALID_EFFECTIVE_DATE');
      }
      const next: BillingState = {
        ...state,
        pending: {
          kind: 'DOWNGRADE',
          planVersionId: event.planVersionId,
          planPriceId: event.planPriceId,
          reference: null,
          effectiveAt: event.effectiveAt,
        },
      };
      return changed(state, next, [
        entry('PLAN_CHANGE_PENDING', state, next, {
          from: state.planVersionId,
          to: event.planVersionId,
          price: event.planPriceId,
        }),
      ]);
    }
  }
}

// The business's current administrative state.
export interface TenantSuspensionState {
  status: 'ACTIVE' | 'SUSPENDED';
  suspensionReason: 'SECURITY' | 'BILLING' | 'REQUESTED' | null;
}

export type SuspensionAction = 'NONE' | 'SUSPEND_BILLING' | 'LIFT_BILLING';

// Applies a billing effect to the business's suspension without ever
// overriding an administrative decision: billing may suspend an ACTIVE
// business (reason BILLING), and may lift ONLY a BILLING suspension. A
// SECURITY or REQUESTED suspension is never changed by billing.
export function decideSuspension(
  effect: SuspensionEffect,
  tenant: TenantSuspensionState,
): SuspensionAction {
  if (effect === 'SUSPEND_FOR_BILLING') {
    return tenant.status === 'ACTIVE' ? 'SUSPEND_BILLING' : 'NONE';
  }
  if (effect === 'LIFT_BILLING_SUSPENSION') {
    return tenant.status === 'SUSPENDED' &&
      tenant.suspensionReason === 'BILLING'
      ? 'LIFT_BILLING'
      : 'NONE';
  }
  return 'NONE';
}
