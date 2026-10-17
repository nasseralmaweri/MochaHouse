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
//   SC3c Q1  an expired trial keeps the CORE business (storefront, basic
//       administration) for a short recovery window (policy
//       trialRecoveryDays, fixed when the trial expires) but never the
//       plan's premium modules (entitledToPlanModules); when the window ends
//       the business is suspended for billing. Nothing is charged.

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
  // SC3c — TRIAL_EXPIRED only: when the restricted recovery window ends
  // (then the business is suspended for billing and this is cleared).
  recoveryEndsAt: Date | null;
  // SC3c-3 — UNPAID only: an operator's explicit, time-limited grace
  // EXCEPTION (temporary access while still UNPAID). Cleared whenever the
  // subscription leaves UNPAID.
  graceExceptionEndsAt: Date | null;
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
      // SC3b — the provider's own trial end (a hosted Checkout trial). When
      // given it is used as-is, still bounded by trialDays (+1 day of slack
      // for the provider's rounding).
      endsAt?: Date;
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
  // Provider: the trial period is over. SC3c — `trialRecoveryDays` (billing
  // policy) is the recovery window an unauthorized trial gets on expiry.
  | { type: 'TRIAL_ENDED'; at: Date; trialRecoveryDays: number }
  // System: the grace period is over.
  | { type: 'GRACE_EXPIRED'; at: Date }
  // SC3c — system: an expired trial's recovery window is over.
  | { type: 'RECOVERY_EXPIRED'; at: Date }
  // SC3c-2 — an ENDED subscription (expired trial or canceled) is replaced
  // by a new provider subscription whose first payment is VERIFIED paid
  // (the caller checks that, and that the old one really ended). Never a
  // trial; the old subscription's history and trial record stay.
  | { type: 'SUBSCRIPTION_REPLACED'; at: Date }
  // SC3c-2 — the provider reports an UNPAID subscription active again with
  // nothing outstanding (the caller verified both live): the recovery is
  // complete even if no single payment event could confirm it.
  | { type: 'RECOVERY_CONFIRMED'; at: Date }
  // SC3c-3 — operator: a PAST_DUE grace period is extended to `endsAt`
  // (the caller enforces the per-episode limit).
  | { type: 'GRACE_EXTENDED'; at: Date; endsAt: Date }
  // SC3c-3 — operator: an UNPAID subscription gets (or extends) an explicit
  // grace exception until `endsAt`. It stays UNPAID; the debt is untouched.
  | { type: 'GRACE_EXCEPTION_GRANTED'; at: Date; endsAt: Date }
  // SC3c-3 — system: the grace exception is over.
  | { type: 'GRACE_EXCEPTION_EXPIRED'; at: Date }
  | { type: 'CANCEL_SCHEDULED'; at: Date }
  | { type: 'CANCEL_UNDONE'; at: Date }
  // Provider: the subscription ended (after a scheduled cancellation, or a
  // cardless trial the provider ended).
  | { type: 'SUBSCRIPTION_ENDED'; at: Date; trialRecoveryDays: number }
  // SC3d-2 — the provider discarded the upgrade waiting for payment
  // `reference` (its pending update expired and the invoice can no longer be
  // paid): the upgrade is abandoned. A failed ATTEMPT never abandons it.
  | { type: 'UPGRADE_ABANDONED'; at: Date; reference: string }
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
    | 'RECOVERY_EXPIRED'
    | 'SUBSCRIPTION_REPLACED'
    | 'GRACE_EXTENDED'
    | 'GRACE_EXCEPTION_GRANTED'
    | 'GRACE_EXCEPTION_EXPIRED'
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
  | 'NOT_IN_RECOVERY'
  | 'RECOVERY_NOT_OVER'
  | 'NOT_UNPAID'
  | 'NO_GRACE_EXCEPTION'
  | 'GRACE_EXCEPTION_NOT_OVER'
  | 'INVALID_EXTENSION'
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
  // SC3c-3 — a grace exception exists only while UNPAID: leaving UNPAID (a
  // payment, a confirmed recovery, the provider ending it) ends it.
  const normalized =
    next.status !== 'UNPAID' && next.graceExceptionEndsAt !== null
      ? { ...next, graceExceptionEndsAt: null }
      : next;
  return { ok: true, changed: true, next: normalized, history, suspension };
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

// SC3c — whether the business keeps its plan's modules (beyond core).
// COMPLIMENTARY, and any subscription in good standing or within its grace
// period, keeps them. An expired trial (including its recovery window), an
// unpaid or an ended subscription does not: the recovery window never
// extends premium access.
//
// SC3c-3 — an UNPAID subscription keeps them while an operator's grace
// exception is in force (`now` before its end).
export function entitledToPlanModules(
  state: Pick<BillingState, 'billingMode' | 'status'> & {
    graceExceptionEndsAt?: Date | null;
  },
  now: Date = new Date(),
): boolean {
  if (state.billingMode === 'COMPLIMENTARY') return true;
  if (state.status === 'UNPAID') {
    return (
      state.graceExceptionEndsAt != null && now < state.graceExceptionEndsAt
    );
  }
  return (
    state.status === 'ACTIVE' ||
    state.status === 'TRIALING' ||
    state.status === 'PAST_DUE'
  );
}

// SC3c — an unauthorized trial expires: NOTHING is charged, and the
// business gets the recovery window (core access) before any suspension.
function expireTrial(
  state: BillingState,
  at: Date,
  trialRecoveryDays: number,
): TransitionResult {
  if (
    !Number.isInteger(trialRecoveryDays) ||
    trialRecoveryDays < 1 ||
    trialRecoveryDays > 14
  ) {
    return refuse('NOT_CHANGEABLE');
  }
  const next: BillingState = {
    ...state,
    status: 'TRIAL_EXPIRED',
    recoveryEndsAt: new Date(at.getTime() + trialRecoveryDays * DAY_MS),
  };
  return changed(state, next, [entry('TRIAL_EXPIRED', state, next)]);
}

export function transition(
  state: BillingState,
  event: BillingEvent,
): TransitionResult {
  if (state.billingMode === 'COMPLIMENTARY') return refuse('COMPLIMENTARY');
  // SC3c-2 — the one way out of CANCELED: a verified, paid replacement.
  if (event.type === 'SUBSCRIPTION_REPLACED') {
    if (state.status !== 'TRIAL_EXPIRED' && state.status !== 'CANCELED') {
      return refuse('NOT_CHANGEABLE');
    }
    const next: BillingState = {
      ...state,
      status: 'ACTIVE',
      // The replacement was paid with a payment method collected for
      // recurring payment (Checkout).
      recurringPaymentAuthorizedAt:
        state.recurringPaymentAuthorizedAt ?? event.at,
      // The new period comes with its paid invoice (PAYMENT_SUCCEEDED).
      currentPeriodStart: null,
      currentPeriodEnd: null,
      pastDueAt: null,
      graceEndsAt: null,
      recoveryEndsAt: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      pending: null,
    };
    return changed(
      state,
      next,
      [entry('SUBSCRIPTION_REPLACED', state, next)],
      'LIFT_BILLING_SUSPENSION',
    );
  }
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
      const trialEndsAt =
        event.endsAt ?? new Date(event.at.getTime() + event.trialDays * DAY_MS);
      if (
        trialEndsAt <= event.at ||
        trialEndsAt.getTime() - event.at.getTime() >
          (event.trialDays + 1) * DAY_MS
      ) {
        return refuse('INVALID_TRIAL');
      }
      const next: BillingState = {
        ...state,
        status: 'TRIALING',
        trialStartedAt: event.at,
        trialEndsAt,
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
        // SC3d-2 — a monthly -> annual change starts a new period (the
        // caller passes the provider's live period); otherwise unchanged.
        const newer =
          event.periodStart !== null &&
          event.periodEnd !== null &&
          event.periodEnd > event.periodStart &&
          (state.currentPeriodEnd === null ||
            event.periodEnd > state.currentPeriodEnd);
        const next: BillingState = {
          ...state,
          planVersionId: state.pending.planVersionId,
          planPriceId: state.pending.planPriceId ?? state.planPriceId,
          currentPeriodStart: newer
            ? event.periodStart
            : state.currentPeriodStart,
          currentPeriodEnd: newer ? event.periodEnd : state.currentPeriodEnd,
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
        recoveryEndsAt: null,
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
      // SC3d-2 — an ATTEMPT on the pending upgrade's own invoice failed: the
      // provider keeps the change waiting (the owner may still pay, e.g.
      // after 3-D Secure). Nothing changes: the plan, the standing — never a
      // delinquency. Only UPGRADE_ABANDONED ends it.
      if (
        state.pending?.kind === 'UPGRADE' &&
        state.pending.reference === event.reference
      ) {
        return unchanged(state);
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
      return expireTrial(state, event.at, event.trialRecoveryDays);
    }

    case 'RECOVERY_CONFIRMED': {
      if (state.status !== 'UNPAID') return refuse('NOT_PAST_DUE');
      const next: BillingState = {
        ...state,
        status: 'ACTIVE',
        pastDueAt: null,
        graceEndsAt: null,
      };
      return changed(
        state,
        next,
        [entry('PAYMENT_SUCCEEDED', state, next)],
        'LIFT_BILLING_SUSPENSION',
      );
    }

    case 'RECOVERY_EXPIRED': {
      if (state.status !== 'TRIAL_EXPIRED' || state.recoveryEndsAt === null) {
        return refuse('NOT_IN_RECOVERY');
      }
      if (event.at < state.recoveryEndsAt) return refuse('RECOVERY_NOT_OVER');
      // The window is over: the business is suspended for billing (still
      // TRIAL_EXPIRED; still never charged).
      const next: BillingState = { ...state, recoveryEndsAt: null };
      return changed(
        state,
        next,
        [entry('RECOVERY_EXPIRED', state, next)],
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

    case 'UPGRADE_ABANDONED': {
      if (
        state.pending?.kind !== 'UPGRADE' ||
        state.pending.reference !== event.reference
      ) {
        return refuse('NOT_CHANGEABLE');
      }
      const next = { ...state, pending: null };
      return changed(state, next, [
        entry('PLAN_CHANGE_ABANDONED', state, next, {
          from: state.planVersionId,
          to: state.pending.planVersionId,
          price: state.pending.planPriceId,
        }),
      ]);
    }

    case 'GRACE_EXTENDED': {
      if (state.status !== 'PAST_DUE' || state.graceEndsAt === null) {
        return refuse('NOT_PAST_DUE');
      }
      const from = Math.max(state.graceEndsAt.getTime(), event.at.getTime());
      if (
        event.endsAt.getTime() <= from ||
        event.endsAt.getTime() - from > 14 * DAY_MS
      ) {
        return refuse('INVALID_EXTENSION');
      }
      const next: BillingState = { ...state, graceEndsAt: event.endsAt };
      return changed(state, next, [entry('GRACE_EXTENDED', state, next)]);
    }

    case 'GRACE_EXCEPTION_GRANTED': {
      if (state.status !== 'UNPAID') return refuse('NOT_UNPAID');
      const from = Math.max(
        state.graceExceptionEndsAt?.getTime() ?? 0,
        event.at.getTime(),
      );
      if (
        event.endsAt.getTime() <= from ||
        event.endsAt.getTime() - from > 14 * DAY_MS
      ) {
        return refuse('INVALID_EXTENSION');
      }
      const next: BillingState = {
        ...state,
        graceExceptionEndsAt: event.endsAt,
      };
      // Temporary access: a BILLING suspension (only that) is lifted; the
      // subscription stays UNPAID and is never recorded as paid.
      return changed(
        state,
        next,
        [entry('GRACE_EXCEPTION_GRANTED', state, next)],
        'LIFT_BILLING_SUSPENSION',
      );
    }

    case 'GRACE_EXCEPTION_EXPIRED': {
      if (state.status !== 'UNPAID' || state.graceExceptionEndsAt === null) {
        return refuse('NO_GRACE_EXCEPTION');
      }
      if (event.at < state.graceExceptionEndsAt) {
        return refuse('GRACE_EXCEPTION_NOT_OVER');
      }
      const next: BillingState = { ...state, graceExceptionEndsAt: null };
      return changed(
        state,
        next,
        [entry('GRACE_EXCEPTION_EXPIRED', state, next)],
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
      // SC3b — a trial ended by the provider because no payment method was
      // ever added (cardless trial): that is TRIAL EXPIRY, recorded
      // distinctly from a voluntary cancellation, and nothing was charged.
      if (
        state.status === 'TRIALING' &&
        state.recurringPaymentAuthorizedAt === null
      ) {
        return expireTrial(state, event.at, event.trialRecoveryDays);
      }
      // Already expired as a trial: the provider ending it changes nothing.
      if (state.status === 'TRIAL_EXPIRED') return unchanged(state);
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
      // SC3c-3 — the provider ended an UNPAID subscription during a grace
      // exception: the exception ends with it and the BILLING suspension it
      // had lifted returns (no stale access). Otherwise unchanged (E7).
      return changed(
        state,
        next,
        [entry('CANCELED', state, next)],
        state.status === 'UNPAID' && state.graceExceptionEndsAt !== null
          ? 'SUSPEND_FOR_BILLING'
          : 'NONE',
      );
    }

    case 'UPGRADE_REQUESTED': {
      if (state.pending !== null) return refuse('CHANGE_PENDING');
      if (state.status !== 'ACTIVE') return refuse('NOT_CHANGEABLE');
      // SC3d-2 — the same plan at another price (monthly <-> annual) IS a
      // change; only the same plan at the same price is not.
      if (
        event.planVersionId === state.planVersionId &&
        event.planPriceId === state.planPriceId
      ) {
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
      // SC3d-2 — the same plan at another price (monthly <-> annual) IS a
      // change; only the same plan at the same price is not.
      if (
        event.planVersionId === state.planVersionId &&
        event.planPriceId === state.planPriceId
      ) {
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
