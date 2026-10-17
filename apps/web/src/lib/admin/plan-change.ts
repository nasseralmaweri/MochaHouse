import type {
  AdminPlanChangeStatus,
  AdminPlanChangeView,
  AdminPlanOption,
  BillingPlanChangePreview,
} from "@mocha-house/contracts";
import { formatDeadline } from "./billing";

// SC3d-2 — the business's own plan change (pure helpers: wording, refusal
// messages, what can be confirmed). A completed upgrade is NEVER shown
// before the payment provider's payment and price are verified (the API's
// APPLIED status is the only source).

export const PLAN_CHANGE_MESSAGES = {
  unavailable: "Plan changes aren't available right now. Nothing was changed. Try again in a moment.",
  notChangeable:
    "Your plan can't be changed right now. Plans can be changed while your subscription is active and nothing else is in progress.",
  samePrice: "That's your current plan and price.",
  currency: "That price is in another currency than your subscription.",
  inProgress: "A plan change is already in progress. This page shows its status.",
  unverified:
    "We couldn't confirm your current price with our payment provider. Our team has been notified; nothing was changed.",
  expired: "This price preview has expired. Choose the plan again to see the current price.",
  changed:
    "The price for this change is no longer the one shown. Choose the plan again to see the new price before confirming.",
  notPayable: "There's no plan change payment to complete. This page shows the latest status.",
  forbidden: "Only someone who manages billing can change the plan.",
  sessionEnded: "Your session has ended. Sign in again to continue.",
  tooMany: "Too many attempts. Wait a few minutes, then try again.",
  laterOnly:
    "This change would start at the end of your billing period. Changes like this aren't available yet; your current plan stays as it is.",
} as const;

const CONFLICTS: Record<string, string> = {
  BILLING_PLAN_CHANGE_UNAVAILABLE: PLAN_CHANGE_MESSAGES.notChangeable,
  BILLING_PLAN_CHANGE_SAME_PRICE: PLAN_CHANGE_MESSAGES.samePrice,
  BILLING_PLAN_CHANGE_CURRENCY: PLAN_CHANGE_MESSAGES.currency,
  BILLING_PLAN_CHANGE_IN_PROGRESS: PLAN_CHANGE_MESSAGES.inProgress,
  BILLING_PLAN_CHANGE_UNVERIFIED: PLAN_CHANGE_MESSAGES.unverified,
  BILLING_PLAN_CHANGE_PREVIEW_EXPIRED: PLAN_CHANGE_MESSAGES.expired,
  BILLING_PLAN_CHANGE_PREVIEW_CHANGED: PLAN_CHANGE_MESSAGES.changed,
  BILLING_PLAN_CHANGE_NOT_PAYABLE: PLAN_CHANGE_MESSAGES.notPayable,
};

// A refused answer's message (never server detail).
export function planChangeRefusalMessage(status: number | null, body: unknown): string {
  if (status === 401) return PLAN_CHANGE_MESSAGES.sessionEnded;
  if (status === 403) return PLAN_CHANGE_MESSAGES.forbidden;
  if (status === 429) return PLAN_CHANGE_MESSAGES.tooMany;
  if (status === 409) {
    const code =
      typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
    if (typeof code === "string" && code in CONFLICTS) return CONFLICTS[code];
  }
  return PLAN_CHANGE_MESSAGES.unavailable;
}

// Only an immediate change can be confirmed in this release.
export function canConfirm(preview: BillingPlanChangePreview, now: number = Date.now()): boolean {
  return (
    preview.timing === "IMMEDIATE" &&
    preview.chargeNow !== null &&
    new Date(preview.expiresAt).getTime() > now
  );
}

export function money(minorUnits: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minorUnits / 100);
}

export function perInterval(interval: "MONTH" | "YEAR"): string {
  return interval === "MONTH" ? "per month" : "per year";
}

export function optionLabel(option: AdminPlanOption): string {
  return `${option.planName} — ${money(option.amountMinorUnits, option.currency)} ${perInterval(option.interval)}`;
}

// The provider's charge, itemized so the lines add up to what is charged
// now (zero lines are left out).
export function chargeLines(
  preview: BillingPlanChangePreview,
): { label: string; amount: string; total?: boolean }[] {
  const charge = preview.chargeNow;
  if (!charge) return [];
  const lines: { label: string; amount: string; total?: boolean }[] = [];
  if (charge.prorationMinorUnits > 0) {
    lines.push({
      label: "New plan for the rest of this period, less unused time",
      amount: money(charge.prorationMinorUnits, charge.currency),
    });
  } else if (charge.prorationMinorUnits < 0) {
    lines.push({
      label: "Credit for unused time",
      amount: `−${money(-charge.prorationMinorUnits, charge.currency)}`,
    });
  }
  if (charge.discountMinorUnits > 0) {
    lines.push({
      label: "Discount",
      amount: `−${money(charge.discountMinorUnits, charge.currency)}`,
    });
  }
  if (charge.taxMinorUnits > 0) {
    lines.push({ label: "Tax", amount: `+${money(charge.taxMinorUnits, charge.currency)}` });
  }
  lines.push({
    label: "Charged now",
    amount: money(charge.amountDueMinorUnits, charge.currency),
    total: true,
  });
  return lines;
}

// When and how much the business pays next, after the change.
export function nextChargeSentence(preview: BillingPlanChangePreview): string {
  const next = preview.nextRecurring;
  const amount = `${money(next.amountMinorUnits, next.currency)} ${perInterval(next.interval)}`;
  if (next.startsAt) {
    return preview.timing === "IMMEDIATE"
      ? `After that: ${amount}, from your next billing date (${formatDeadline(next.startsAt)}).`
      : `Your new price: ${amount}, from ${formatDeadline(next.startsAt)}. Nothing is charged now.`;
  }
  // Monthly -> annual: the charge now starts the new yearly period.
  return `The charge now starts your new billing period; after that: ${amount}.`;
}

// The status line for the business's latest plan change.
export function planChangeStatusMessage(view: AdminPlanChangeView): string {
  const target = `${view.target.planName} (${money(
    view.target.price.amountMinorUnits,
    view.target.price.currency,
  )} ${perInterval(view.target.price.interval)})`;
  const messages: Record<AdminPlanChangeStatus, string> = {
    PROCESSING: `We're confirming your change to ${target} with our payment provider. Your current plan stays active until the payment is confirmed. Refresh this page in a minute.`,
    PAYMENT_NEEDED: `Your change to ${target} needs payment. The charge didn't go through yet (for example a declined card or an extra security check). Your current plan stays active; nothing changes until the payment is completed.`,
    APPLIED: `Your plan is now ${target}. The payment was confirmed.`,
    REVIEW: `Your change to ${target} is being checked by our team. You don't need to do anything now; we'll confirm any charge with you.`,
    EXPIRED: `Your change to ${target} wasn't completed because the payment wasn't finished in time. Nothing changed and you weren't charged for it.`,
    FAILED: `Your change to ${target} couldn't be completed. Nothing changed.`,
  };
  return messages[view.status];
}
