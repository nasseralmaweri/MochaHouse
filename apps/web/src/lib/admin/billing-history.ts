import type {
  BillingInvoiceAdjustmentView,
  BillingInvoiceReason,
  BillingInvoiceStatus,
  BillingInvoiceView,
  BillingPaymentMethodView,
} from "@mocha-house/contracts";
import { formatMinorUnits } from "./crm";

// SC3e-1 — the business's CENTERIVO billing history (pure helpers: labels,
// amounts, dates, the saved card). Payments from the business's own
// customers are never shown here. Amounts are the billing provider's own.

export const BILLING_HISTORY_MESSAGES = {
  empty: "No invoices yet. Invoices appear here once your subscription is billed.",
  unavailable: "We couldn't load your billing history right now. Try again in a moment.",
  invalidPage: "That page of your billing history is no longer available. Showing the newest invoices.",
  documentUnavailable: "This invoice's document isn't available right now. Try again in a moment.",
  noDocument: "This invoice has no document to show.",
  notFound: "We couldn't find that invoice. Refresh this page and try again.",
  forbidden: "Only someone who can view billing can open invoices.",
  sessionEnded: "Your session has ended. Sign in again to continue.",
  tooMany: "Too many attempts. Wait a few minutes, then try again.",
  paymentMethodUnavailable: "We couldn't load your payment method right now.",
} as const;

export const INVOICE_STATUS_LABELS: Record<BillingInvoiceStatus, string> = {
  paid: "Paid",
  open: "Payment due",
  uncollectible: "Unpaid",
  void: "Voided (not payable)",
};

export const INVOICE_REASON_LABELS: Record<BillingInvoiceReason, string> = {
  SUBSCRIPTION_START: "Subscription start",
  RENEWAL: "Renewal",
  PLAN_CHANGE: "Plan change",
  OTHER: "Invoice",
};

// A calendar date (UTC, as the billing provider dates invoices).
export function invoiceDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });
}

// The period an invoice bills, e.g. "Oct 1, 2026 – Nov 1, 2026" (null:
// none reported).
export function invoicePeriod(invoice: BillingInvoiceView): string | null {
  if (!invoice.periodStart || !invoice.periodEnd) return null;
  return `${invoiceDate(invoice.periodStart)} – ${invoiceDate(invoice.periodEnd)}`;
}

// The amounts worth showing (zero lines left out except the total).
export function invoiceAmountLines(invoice: BillingInvoiceView): { label: string; amount: string }[] {
  const money = (minorUnits: number) => formatMinorUnits(minorUnits, invoice.currency);
  const lines = [{ label: "Total", amount: money(invoice.totalMinorUnits) }];
  if (invoice.creditAppliedMinorUnits > 0) {
    lines.push({ label: "Credit applied", amount: `−${money(invoice.creditAppliedMinorUnits)}` });
  }
  if (invoice.amountPaidMinorUnits > 0) {
    lines.push({ label: "Paid", amount: money(invoice.amountPaidMinorUnits) });
  }
  if (invoice.amountRemainingMinorUnits > 0 && invoice.status !== "void") {
    lines.push({ label: "Still due", amount: money(invoice.amountRemainingMinorUnits) });
  }
  if (invoice.refundedOrCreditedMinorUnits > 0) {
    lines.push({
      label: "Refunds and credits from our payment provider",
      amount: money(invoice.refundedOrCreditedMinorUnits),
    });
  }
  return lines;
}

// SC3e-3 — a refund or credit on the invoice, as the business sees it
// (read-only): what it is, how much, and whether it is complete.
export function invoiceAdjustmentLine(adjustment: BillingInvoiceAdjustmentView): string {
  const amount = formatMinorUnits(adjustment.totalMinorUnits, adjustment.currency);
  const what =
    adjustment.kind === "REFUND"
      ? `Refund of ${amount} to your payment method`
      : `Credit of ${amount} toward future invoices`;
  return adjustment.status === "COMPLETED"
    ? `${what} · completed ${invoiceDate(adjustment.at)}`
    : `${what} · in progress`;
}

const BRANDS: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  cartes_bancaires: "Cartes Bancaires",
  eftpos_au: "eftpos",
  interac: "Interac",
};

// "Visa ending in 4242, expires 12/2030" — only what the API returns.
export function paymentMethodSentence(method: BillingPaymentMethodView): string {
  if (method.kind === "NONE") return "No payment method on file.";
  if (method.kind === "OTHER" || !method.card) return "A payment method is on file.";
  const brand = BRANDS[method.card.brand] ?? "Card";
  const month = String(method.card.expMonth).padStart(2, "0");
  return `${brand} ending in ${method.card.last4}, ${method.card.expired ? "expired" : "expires"} ${month}/${method.card.expYear}`;
}

// Only a cursor the API itself issued is passed back (base64url, bounded).
export function pageCursor(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : null;
}

// A refused document request, in plain words (never server detail).
export function documentRefusalMessage(status: number | null, body: unknown): string {
  if (status === 401) return BILLING_HISTORY_MESSAGES.sessionEnded;
  if (status === 403) return BILLING_HISTORY_MESSAGES.forbidden;
  if (status === 404) return BILLING_HISTORY_MESSAGES.notFound;
  if (status === 429) return BILLING_HISTORY_MESSAGES.tooMany;
  if (status === 409) {
    const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
    if (code === "BILLING_DOCUMENT_UNAVAILABLE") return BILLING_HISTORY_MESSAGES.noDocument;
  }
  return BILLING_HISTORY_MESSAGES.documentUnavailable;
}
