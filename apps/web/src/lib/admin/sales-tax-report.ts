import type { SalesTaxReportRefund } from "@mocha-house/contracts";
import { formatPrice } from "@/lib/money";

// V1 Sales Tax PR 3 — plain-language pieces of the sales tax report.

export const SALES_TAX_REPORT_SCOPE =
  "Orders taxed at checkout only (orders from before sales tax are not included). Sales and tax collected are by order date; tax refunded counts confirmed refunds only, by refund date. Dates are in the business's reporting time zone.";

// A withheld net (unattributed refunds in the period) is never shown as a
// number.
export function netTaxLabel(netMinorUnits: number | null, currency: string): string {
  return netMinorUnits === null ? "Not final" : formatPrice(netMinorUnits, currency);
}

export function taxRefundKindLabel(kind: SalesTaxReportRefund["kind"]): string {
  switch (kind) {
    case "ITEM":
      return "Item refund";
    case "CANCELLATION":
      return "Cancellation";
    default:
      return "Amount refund (tax not attributed)";
  }
}

export function taxRefundStatusView(status: SalesTaxReportRefund["status"]): {
  label: string;
  tone: "neutral" | "positive" | "warning";
} {
  switch (status) {
    case "CONFIRMED":
      return { label: "Counted", tone: "positive" };
    case "PENDING":
      return { label: "Pending — not counted yet", tone: "neutral" };
    case "FAILED":
      return { label: "Did not happen — not counted", tone: "neutral" };
    default:
      return { label: "Needs tax attribution", tone: "warning" };
  }
}
