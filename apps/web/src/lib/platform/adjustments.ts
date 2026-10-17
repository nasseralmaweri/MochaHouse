import type {
  BillingAdjustmentKind,
  BillingAdjustmentStatus,
  PlatformAdjustmentView,
  PlatformPermission,
} from "@mocha-house/contracts";
import { formatMinorUnits } from "@/lib/admin/crm";

// SC3e-3 — refunds and credits on CENTERIVO subscription invoices (pure
// helpers: wording, the approval policy as operators read it, what the
// console offers, amount input). The API is the authority: it re-checks every
// permission, approver and amount on every request, and the payment
// provider computes every amount and tax.

export const ADJUSTMENT_STATUS_LABELS: Record<BillingAdjustmentStatus, string> = {
  PENDING_APPROVAL: "Awaiting approval",
  EXECUTING: "Being carried out — waiting for the payment provider",
  SUBMITTED: "Submitted — the refund is pending at the payment provider",
  SUCCEEDED: "Completed",
  REJECTED: "Rejected",
  CANCELED: "Withdrawn by the requester",
  EXPIRED: "Expired (not approved within 72 hours)",
  FAILED: "Not carried out",
  REVIEW: "Needs review — the outcome at the payment provider is uncertain",
  RECORDED: "Recorded (made directly at the payment provider)",
};

export const ADJUSTMENT_KIND_LABELS: Record<BillingAdjustmentKind, string> = {
  REFUND: "Refund to the original payment method",
  CREDIT: "Credit toward future invoices",
  OUT_OF_BAND: "Refunded outside the payment provider",
};

export const ADJUSTMENT_FAILURE_LABELS: Record<string, string> = {
  PREVIEW_CHANGED: "The payment provider's amount or tax changed after approval; nothing was issued. Request it again.",
  EXCEEDS_REMAINING: "Less remained on the invoice than approved; nothing was issued.",
  NOT_REFUNDABLE: "The payment can no longer be refunded; nothing was issued.",
  INVOICE_CHANGED: "The invoice changed at the payment provider; nothing was issued.",
  NOT_ISSUED: "Confirmed with the payment provider that nothing was issued.",
  UNCERTAIN: "The payment provider didn't confirm in time. Check the provider before resolving.",
  APPROVAL_REVOKED: "An approval stopped counting before the payment provider confirmed it.",
  REFUND_FAILED: "The payment provider issued the credit note but the refund failed.",
  REFUND_AMOUNT_MISMATCH: "The refund at the payment provider doesn't match the approved amount.",
  CREDIT_NOTE_MISMATCH: "The credit note at the payment provider doesn't match what was approved.",
  DUPLICATE_CREDIT_NOTES: "More than one credit note carries this request's reference.",
  CREDIT_REFUNDED: "A credit was approved, but the payment provider refunded money.",
};

export const ADJUSTMENT_EVENT_LABELS: Record<string, string> = {
  REQUESTED: "Requested",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CANCELED: "Withdrawn",
  EXPIRED: "Expired",
  EXECUTING: "Reserved and sent to the payment provider",
  CREDIT_NOTE_REQUESTED: "Payment provider accepted the credit note",
  SUBMIT_UNCERTAIN: "Payment provider didn't answer (checked again before anything is re-sent)",
  SUBMIT_DEFERRED: "Payment provider unavailable before sending (nothing sent)",
  SUBMITTED: "Refund pending at the payment provider",
  SUCCEEDED: "Confirmed by the payment provider",
  FAILED: "Not carried out",
  REVIEW: "Needs review",
  RECORDED: "Recorded from the payment provider",
};

// D5 — shown on every confirmation.
export const FUTURE_CHARGES = "A full refund does not automatically stop future subscription charges.";
export const NO_ACCESS_EFFECTS = `${FUTURE_CHARGES} The subscription keeps renewing unless it is cancelled separately. A refund or credit changes nothing else: the plan, status and modules stay as they are, and no suspension is lifted.`;

export const APPROVAL_POLICY =
  "One independent approver under $250 USD; two different approvers at $250 or more, for any other currency, and for a full refund of an annual period. The requester never approves its own request. Requests expire after 72 hours.";

export function money(minorUnits: number, currency: string): string {
  return formatMinorUnits(minorUnits, currency);
}

export function approvalsLabel(view: Pick<PlatformAdjustmentView, "requiredApprovals" | "decisions">): string {
  const approved = view.decisions.filter((decision) => decision.decision === "APPROVED").length;
  return `${approved} of ${view.requiredApprovals} approval${view.requiredApprovals === 1 ? "" : "s"}`;
}

export const OPEN_STATUSES: readonly BillingAdjustmentStatus[] = [
  "PENDING_APPROVAL",
  "EXECUTING",
  "SUBMITTED",
  "REVIEW",
];

// What this operator may do with an adjustment (the API decides).
export function adjustmentActions(
  view: Pick<PlatformAdjustmentView, "origin" | "status" | "requestedBy" | "decisions">,
  operatorId: string | null,
  permissions: readonly PlatformPermission[],
): { decide: boolean; cancel: boolean; resolve: boolean; reason: string | null } {
  const none = { decide: false, cancel: false, resolve: false };
  if (view.origin !== "CENTERIVO") return { ...none, reason: null };
  const own = operatorId !== null && view.requestedBy?.id === operatorId;
  const approver = permissions.includes("billing.adjustments.approve");
  if (view.status === "REVIEW") {
    return approver
      ? { ...none, resolve: true, reason: null }
      : { ...none, reason: "Resolving it needs billing.adjustments.approve." };
  }
  if (view.status !== "PENDING_APPROVAL") return { ...none, reason: null };
  const decided = view.decisions.some((decision) => decision.operator.id === operatorId);
  if (own) {
    return {
      ...none,
      cancel: permissions.includes("billing.adjustments.request"),
      reason: "You requested this, so another operator must approve it.",
    };
  }
  if (decided) return { ...none, reason: "You already decided; another operator must." };
  if (!approver) return { ...none, reason: "Approving needs billing.adjustments.approve." };
  return { ...none, decide: true, reason: null };
}

// An amount typed in major units ("12.50") as minor units, or null.
export function parseAmount(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return minor > 0 ? minor : null;
}

export function validNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length < 10 || text.length > 500) return null;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return text;
}
