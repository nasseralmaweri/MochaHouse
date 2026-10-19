import {
  PAYMENT_CASE_CATEGORIES,
  PAYMENT_CASE_NOTE_MAX_LENGTH,
  PAYMENT_CASE_REASON_MAX_LENGTH,
  PAYMENT_CASE_REASON_MIN_LENGTH,
  PAYMENT_RECOVERY_CASE_RESOLVED,
  PAYMENT_RECOVERY_IN_PROGRESS,
  PAYMENT_RECOVERY_NOT_CONFIRMED,
  PAYMENT_RECOVERY_NOTHING_TO_RECOVER,
  type PaymentCaseCategory,
  type PaymentCaseStatus,
  type PaymentRecoveryResult,
  type PlatformPaymentCaseDetail,
} from "@mocha-house/contracts";

// ESP-03 PR 5 — wording and answer handling for restaurant payment
// reconciliation in the Platform Console. The API decides everything
// (permissions, recent sign-in, which payments can be recovered); this only
// presents it. A recovery never charges a customer.

export const PAYMENTS_VIEW_PERMISSION = "payments.reconciliation.view";
export const PAYMENTS_MANAGE_PERMISSION = "payments.reconciliation.manage";

export const CATEGORY_LABEL: Record<PaymentCaseCategory, string> = {
  NEEDS_ATTENTION: "Needs attention",
  RECOVERY_IN_PROGRESS: "Recovery in progress",
  RECOVERED: "Recovered",
  AWAITING_PAYMENT_OUTCOME: "Awaiting verified payment outcome",
  CLOSED: "Closed",
};

export const CATEGORY_HINT: Record<PaymentCaseCategory, string> = {
  NEEDS_ATTENTION:
    "The payment is confirmed but its order or gift card is missing, or the case needs a person to look at it.",
  RECOVERY_IN_PROGRESS: "A recovery attempt is running right now.",
  RECOVERED: "The order or gift card exists; the case is resolved.",
  AWAITING_PAYMENT_OUTCOME:
    "The payment provider has not confirmed the outcome. Nothing can be recovered until it does — do not ask the customer to pay again.",
  CLOSED: "Resolved.",
};

export type CategoryFilter = PaymentCaseCategory | "all";
export const CATEGORY_FILTERS: readonly CategoryFilter[] = [
  "all",
  "NEEDS_ATTENTION",
  "RECOVERY_IN_PROGRESS",
  "AWAITING_PAYMENT_OUTCOME",
  "RECOVERED",
  "CLOSED",
];
export const CATEGORY_FILTER_LABEL: Record<CategoryFilter, string> = {
  all: "All",
  ...CATEGORY_LABEL,
};

export const STATUS_LABEL: Record<PaymentCaseStatus, string> = {
  OPEN: "Open",
  IN_REVIEW: "In review",
  RESOLVED: "Resolved",
};

export const REASON_LABEL: Record<string, string> = {
  FULFILMENT_FAILED: "Payment succeeded, order or gift card could not be created",
  FULFILMENT_INCOMPLETE: "Payment succeeded, order or gift card was never created",
  CHARGE_CLAIM_STRANDED: "Payment was started but never sent to the provider",
  PROVIDER_OUTCOME_UNKNOWN: "The provider's answer is unknown",
  PROVIDER_AWAITING_CONFIRMATION: "The provider has not confirmed the payment yet",
  PROVIDER_OUTCOME_UNRECORDED: "The provider's answer could not be recorded",
  PROVIDER_SUCCEEDED_UNRECORDED: "The payment succeeded but that could not be recorded at once",
  LEGACY_SUCCEEDED_UNFULFILLED: "Older payment without its order or gift card",
  LEGACY_PENDING_UNRESOLVED: "Older payment whose outcome was never settled",
};

export const FAILURE_LABEL: Record<string, string> = {
  FULFILMENT_REJECTED:
    "The order could not be created from the saved checkout (the cart, a price, a discount or the location changed). Check the menu, then retry.",
  SNAPSHOT_UNREADABLE: "The saved checkout could not be read. It needs a manual investigation.",
  GIFT_CARD_ISSUE_FAILED: "The gift card could not be issued. It can be retried.",
  TRANSIENT_ERROR: "A temporary error stopped the recovery. It can be retried.",
};

export const EVENT_LABEL: Record<string, string> = {
  OPENED: "Case opened",
  RESOLVED: "Case resolved",
  RECOVERY_STARTED: "Recovery started",
  RECOVERY_SUCCEEDED: "Recovery succeeded",
  RECOVERY_FAILED: "Recovery failed",
};

export const RESULT_MESSAGE: Record<PaymentRecoveryResult, string> = {
  RECOVERED: "Recovered: the missing order or gift card now exists. The customer was not charged again.",
  ALREADY_FULFILLED: "The order or gift card already existed; the case is resolved. Nothing was charged.",
  FAILED: "The recovery did not succeed. The case stays open. Nothing was charged.",
};

export function labelOf(map: Record<string, string>, code: string | null): string {
  if (code === null) return "—";
  return map[code] ?? code;
}

export function formatMinorUnits(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}

// --- filters -----------------------------------------------------------

export interface PaymentCaseFilters {
  category: CategoryFilter;
  tenantId: string;
  from: string;
  to: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function first(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? "") : "";
}

export function paymentCaseFilters(
  params: Record<string, string | string[] | undefined>,
): PaymentCaseFilters {
  const category = first(params.category);
  const tenantId = first(params.tenantId).trim();
  const from = first(params.from);
  const to = first(params.to);
  return {
    category: (CATEGORY_FILTERS as readonly string[]).includes(category)
      ? (category as CategoryFilter)
      : "NEEDS_ATTENTION",
    tenantId: ID.test(tenantId) ? tenantId : "",
    from: DATE.test(from) ? from : "",
    to: DATE.test(to) ? to : "",
  };
}

// The API query (only what is set).
export function paymentCaseApiQuery(filters: PaymentCaseFilters): string {
  const query = new URLSearchParams();
  if (filters.category !== "all") query.set("category", filters.category);
  if (filters.tenantId) query.set("tenantId", filters.tenantId);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  return query.toString();
}

// The console page's own link (keeps "all" explicit).
export function paymentCaseHref(filters: PaymentCaseFilters): string {
  const query = new URLSearchParams({ category: filters.category });
  if (filters.tenantId) query.set("tenantId", filters.tenantId);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  return `/platform/payments?${query.toString()}`;
}

export const KNOWN_CATEGORIES: readonly PaymentCaseCategory[] = PAYMENT_CASE_CATEGORIES;

// --- actions -----------------------------------------------------------

export const PAYMENT_CASE_MESSAGES = {
  reason: `Give a reason of ${PAYMENT_CASE_REASON_MIN_LENGTH} to ${PAYMENT_CASE_REASON_MAX_LENGTH} characters.`,
  note: `Write a note of 1 to ${PAYMENT_CASE_NOTE_MAX_LENGTH} characters.`,
  sessionEnded: "Your console session has ended. Sign in again.",
  reauth: "This needs a recent sign-in. Sign out and sign in again, then retry — you'll need to enter the text again.",
  denied: "Your operator account doesn't have permission to act on payment cases. Ask a CENTERIVO administrator to grant payments.reconciliation.manage.",
  notFound: "That case no longer exists. Reload the page.",
  tooMany: "Too many changes right now. Wait a moment and try again.",
  unavailable: "That couldn't be done right now. Try again.",
} as const;

const REFUSAL_MESSAGE: Record<string, string> = {
  [PAYMENT_RECOVERY_NOT_CONFIRMED]:
    "This payment is not confirmed as successful, so nothing can be recovered. It stays open until the payment outcome is verified.",
  [PAYMENT_RECOVERY_NOTHING_TO_RECOVER]:
    "There is nothing saved to recover this payment from. It needs a manual investigation.",
  [PAYMENT_RECOVERY_IN_PROGRESS]: "A recovery of this payment is already running. Refresh in a moment.",
  [PAYMENT_RECOVERY_CASE_RESOLVED]: "This case is already resolved. Nothing was done. Reload the page.",
};

export type PaymentCaseOutcome =
  | { kind: "ok"; detail: PlatformPaymentCaseDetail; message: string }
  | { kind: "reauth" }
  | { kind: "error"; message: string };

function field(body: unknown, key: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

export function interpretPaymentCaseChange(
  intent: "recover" | "note",
  status: number | null,
  body: unknown,
): PaymentCaseOutcome {
  if (status === 200 && body && typeof body === "object") {
    if (intent === "recover") {
      const result = field(body, "result") as PaymentRecoveryResult;
      const detail = field(body, "detail") as PlatformPaymentCaseDetail;
      const failure = field(body, "failure");
      const base = RESULT_MESSAGE[result] ?? RESULT_MESSAGE.FAILED;
      return {
        kind: "ok",
        detail,
        message:
          result === "FAILED" && typeof failure === "string"
            ? `${base} ${labelOf(FAILURE_LABEL, failure)}`
            : base,
      };
    }
    return { kind: "ok", detail: body as PlatformPaymentCaseDetail, message: "Note added." };
  }
  switch (status) {
    case 400: {
      const message = field(body, "message");
      return {
        kind: "error",
        message:
          typeof message === "string"
            ? message.slice(0, 300)
            : intent === "recover"
              ? PAYMENT_CASE_MESSAGES.reason
              : PAYMENT_CASE_MESSAGES.note,
      };
    }
    case 401:
      return field(body, "code") === "REAUTHENTICATION_REQUIRED"
        ? { kind: "reauth" }
        : { kind: "error", message: PAYMENT_CASE_MESSAGES.sessionEnded };
    case 403:
      return { kind: "error", message: PAYMENT_CASE_MESSAGES.denied };
    case 404:
      return { kind: "error", message: PAYMENT_CASE_MESSAGES.notFound };
    case 409: {
      const code = field(body, "code");
      return {
        kind: "error",
        message:
          (typeof code === "string" ? REFUSAL_MESSAGE[code] : undefined) ??
          PAYMENT_CASE_MESSAGES.unavailable,
      };
    }
    case 429:
      return { kind: "error", message: PAYMENT_CASE_MESSAGES.tooMany };
    default:
      return { kind: "error", message: PAYMENT_CASE_MESSAGES.unavailable };
  }
}

export function validRecoveryReason(reason: string): boolean {
  const trimmed = reason.trim();
  return (
    trimmed.length >= PAYMENT_CASE_REASON_MIN_LENGTH && trimmed.length <= PAYMENT_CASE_REASON_MAX_LENGTH
  );
}

export function validNote(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.length >= 1 && trimmed.length <= PAYMENT_CASE_NOTE_MAX_LENGTH;
}

// Ids sent back to the API in a path: only id-shaped values.
export function validCaseId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,64}$/.test(value);
}
