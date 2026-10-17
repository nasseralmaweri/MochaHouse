import type {
  PlatformCaseOutcome,
  PlatformComplimentaryGrantView,
  PlatformPermission,
} from "@mocha-house/contracts";

// SC3e-2 — operator billing controls (pure helpers: wording, validation,
// what the console offers). The API is the authority: it re-checks every
// permission and rule on every request; hiding a control here is only for
// clarity.

export function holds(permissions: readonly PlatformPermission[], permission: PlatformPermission): boolean {
  return permissions.includes(permission);
}

export const COMPLIMENTARY_STATUS_LABELS: Record<PlatformComplimentaryGrantView["status"], string> = {
  SCHEDULED: "Scheduled — starts when the paid period ends",
  ACTIVE: "Active",
  WITHDRAWN: "Withdrawn before it started",
  ENDED: "Ended",
};

export const COMPLIMENTARY_FINISH_LABELS: Record<string, string> = {
  EXPIRED: "Ended on its end date",
  REVOKED: "Revoked by an operator",
  WITHDRAWN: "Withdrawn by an operator",
  PROVIDER_UNDONE: "Withdrawn: the payment provider's cancellation was undone outside CENTERIVO (under review)",
  NOT_SUBMITTED: "Withdrawn: the payment provider never confirmed the cancellation",
};

export const PREVIOUS_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Paying (active)",
  TRIALING: "In trial",
  PAST_DUE: "Payment failed",
  UNPAID: "Unpaid",
  TRIAL_EXPIRED: "Trial expired",
  CANCELED: "Subscription ended",
};

export const CASE_OUTCOME_LABELS: Record<PlatformCaseOutcome, string> = {
  FIXED_AT_PROVIDER: "Fixed at the payment provider",
  SCHEDULE_RELEASED: "Leftover schedule released",
  CONSISTENT_ON_RECHECK: "Consistent when rechecked",
  NO_ACTION_NEEDED: "No action needed",
  DUPLICATE: "Duplicate of another case",
  NEEDS_FINANCIAL_ADJUSTMENT: "Needs a financial adjustment (later release)",
};

export const CASE_ACTION_LABELS: Record<string, string> = {
  RECHECKED: "Rechecked with the payment provider",
  SCHEDULE_RELEASED: "Released a leftover schedule",
  CLOSED: "Closed",
};

export const RECHECK_RESULT_LABELS: Record<string, string> = {
  CONSISTENT: "Our records match the payment provider.",
  MISMATCH_FOUND: "The payment provider differs from our records; see the open cases.",
  PROVIDER_UNAVAILABLE: "The payment provider couldn't be read. Nothing was changed.",
};

// "Indefinite", or the end date (UTC).
export function grantEnd(grant: Pick<PlatformComplimentaryGrantView, "endsAt">): string {
  return grant.endsAt
    ? `Until ${new Date(grant.endsAt).toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" })}`
    : "Indefinite";
}

export function grantAttention(grant: PlatformComplimentaryGrantView): string | null {
  if (grant.attention === "CANCELLATION_UNVERIFIED") {
    return "The payment provider hasn't confirmed the cancellation at period end yet. It is checked again automatically; nothing has changed for the business.";
  }
  if (grant.attention === "ENDS_SOON") {
    return "Ends within 14 days. The business then returns to billing (no automatic charge).";
  }
  return null;
}

// The end date an operator typed (a calendar date, end of that day UTC),
// between tomorrow and three years from now; or null for indefinite.
export function parseEndDate(
  value: unknown,
  now: number = Date.now(),
): { ok: true; endsAt: string | null } | { ok: false; message: string } {
  if (value === null || value === undefined || value === "") return { ok: true, endsAt: null };
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { ok: false, message: "Choose an end date, or indefinite." };
  }
  const end = new Date(`${value}T23:59:00.000Z`);
  if (Number.isNaN(end.getTime())) return { ok: false, message: "Choose an end date, or indefinite." };
  const day = 24 * 60 * 60 * 1000;
  if (end.getTime() < now + day || end.getTime() > now + 3 * 365 * day) {
    return { ok: false, message: "The end date must be between tomorrow and three years from now." };
  }
  return { ok: true, endsAt: end.toISOString() };
}

export function validReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  return reason.length >= 10 && reason.length <= 500 && !/[\u0000-\u001f\u007f]/.test(reason) ? reason : null;
}
