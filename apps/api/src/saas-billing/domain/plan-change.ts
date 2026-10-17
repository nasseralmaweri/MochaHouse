import type {
  ProviderSubscriptionItem,
  ProviderSubscriptionSnapshot,
} from './provider-sync';

// SC3d — plan changes, as PURE rules (no database, no provider, no clock).
//
// Owner decisions (SC3d D2–D7):
//   * an upgrade (a higher price at the same interval) and monthly -> annual
//     are IMMEDIATE: charged now with the provider's proration, and the new
//     plan applies only once that payment is verified;
//   * a downgrade (a lower or equal price at the same interval) and annual
//     -> monthly happen at the END of the current period (no refund, no
//     credit; the current plan is kept until then);
//   * during a trial, the business only chooses the plan the trial becomes
//     (TRIAL_END): the trial is not ended early, nothing is charged, no new
//     module is granted;
//   * a change is only possible while ACTIVE or TRIALING — past due, unpaid,
//     ended or suspended businesses recover their billing first.

export type PlanChangeTiming = 'IMMEDIATE' | 'PERIOD_END' | 'TRIAL_END';

export interface PlanPriceTerms {
  amountMinorUnits: number;
  currency: string;
  interval: 'MONTH' | 'YEAR';
}

export type PlanChangeRefusal =
  'NOT_CHANGEABLE' | 'SAME_PRICE' | 'CURRENCY_MISMATCH';

export function planChangeTiming(
  status: string,
  current: PlanPriceTerms & { id: string },
  target: PlanPriceTerms & { id: string },
):
  | { ok: true; timing: PlanChangeTiming }
  | { ok: false; reason: PlanChangeRefusal } {
  if (status !== 'ACTIVE' && status !== 'TRIALING') {
    return { ok: false, reason: 'NOT_CHANGEABLE' };
  }
  if (current.id === target.id) return { ok: false, reason: 'SAME_PRICE' };
  // A subscription bills in ONE currency for its whole life.
  if (current.currency.toUpperCase() !== target.currency.toUpperCase()) {
    return { ok: false, reason: 'CURRENCY_MISMATCH' };
  }
  if (status === 'TRIALING') return { ok: true, timing: 'TRIAL_END' };
  if (current.interval === target.interval) {
    return {
      ok: true,
      // An equal price on another plan is not an upgrade: nothing is paid
      // for it, so it never applies before the period ends.
      timing:
        target.amountMinorUnits > current.amountMinorUnits
          ? 'IMMEDIATE'
          : 'PERIOD_END',
    };
  }
  return {
    ok: true,
    timing: target.interval === 'YEAR' ? 'IMMEDIATE' : 'PERIOD_END',
  };
}

export type BilledPriceProblem =
  | 'ITEMS_UNKNOWN'
  | 'NOT_ONE_ITEM'
  | 'PRICE_MISMATCH'
  | 'SCHEDULE_ATTACHED'
  | 'PENDING_UPDATE';

// What the provider bills must be exactly what our records say: ONE item,
// quantity 1, at our price; no schedule and no update waiting for payment
// (those are changes already in flight). Anything not read fails closed.
export function verifyBilledPrice(
  snapshot: ProviderSubscriptionSnapshot,
  expectedExternalPriceId: string | null,
):
  | { ok: true; item: ProviderSubscriptionItem }
  | { ok: false; problem: BilledPriceProblem } {
  if (snapshot.items === undefined || snapshot.items.length === 0) {
    return { ok: false, problem: 'ITEMS_UNKNOWN' };
  }
  if (snapshot.items.length !== 1 || snapshot.items[0].quantity !== 1) {
    return { ok: false, problem: 'NOT_ONE_ITEM' };
  }
  const item = snapshot.items[0];
  if (
    expectedExternalPriceId === null ||
    item.externalPriceId !== expectedExternalPriceId
  ) {
    return { ok: false, problem: 'PRICE_MISMATCH' };
  }
  if (snapshot.scheduleId === undefined || snapshot.scheduleId !== null) {
    return { ok: false, problem: 'SCHEDULE_ATTACHED' };
  }
  if (snapshot.hasPendingUpdate !== false) {
    return { ok: false, problem: 'PENDING_UPDATE' };
  }
  return { ok: true, item };
}

// Operation-scoped idempotency keys for provider calls: one plan change, one
// step — a retry of the same step is the same request at the provider, a
// different change never collides.
export function planChangeIdempotencyKey(
  planChangeId: string,
  step: 'change-now' | 'schedule' | 'release',
): string {
  return `centerivo-plan-change-${planChangeId}-${step}`;
}

// SC3d-3 (owner decision D4) — a scheduled change is made or cancelled only
// up to an hour before the period (or trial) end.
export const PLAN_CHANGE_CUTOFF_MS = 60 * 60 * 1000;

// How long a preview may be confirmed (owner decision: 10 minutes).
export const PLAN_CHANGE_PREVIEW_TTL_MS = 10 * 60 * 1000;
