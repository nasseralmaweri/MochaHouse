import type { ReactNode } from "react";
import type { BillingInvoiceView } from "@mocha-house/contracts";
import {
  INVOICE_REASON_LABELS,
  INVOICE_STATUS_LABELS,
  invoiceAdjustmentLine,
  invoiceAmountLines,
  invoiceDate,
  invoicePeriod,
} from "@/lib/admin/billing-history";

// SC3e-1 — a page of CENTERIVO subscription invoices (business billing page
// and the operator console). `actions` adds per-invoice controls (the
// business's document buttons); operators get none.
export function InvoiceList({
  invoices,
  actions,
}: {
  invoices: BillingInvoiceView[];
  actions?: (invoice: BillingInvoiceView, label: string) => ReactNode;
}) {
  return (
    <ul className="flex flex-col gap-3">
      {invoices.map((invoice) => {
        const label = `${invoice.number ?? "invoice"} of ${invoiceDate(invoice.issuedAt)}`;
        const period = invoicePeriod(invoice);
        return (
          <li
            key={invoice.id}
            className="flex flex-col gap-3 rounded-lg border border-border-default px-3 py-3 text-sm"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="font-medium text-text-primary">
                {INVOICE_REASON_LABELS[invoice.reason]} · {invoiceDate(invoice.issuedAt)}
              </p>
              <p
                className={
                  invoice.status === "paid"
                    ? "font-medium text-text-primary"
                    : invoice.status === "void"
                      ? "font-medium text-text-secondary"
                      : "font-medium text-status-error"
                }
              >
                {INVOICE_STATUS_LABELS[invoice.status]}
              </p>
            </div>
            <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
              {invoice.number ? (
                <div className="flex flex-wrap gap-x-2">
                  <dt className="text-text-secondary">Number</dt>
                  <dd className="break-words text-text-primary">{invoice.number}</dd>
                </div>
              ) : null}
              {period ? (
                <div className="flex flex-wrap gap-x-2">
                  <dt className="text-text-secondary">Period</dt>
                  <dd className="break-words text-text-primary">{period}</dd>
                </div>
              ) : null}
              {invoiceAmountLines(invoice).map((line) => (
                <div key={line.label} className="flex flex-wrap gap-x-2">
                  <dt className="text-text-secondary">{line.label}</dt>
                  <dd className="break-words text-text-primary">{line.amount}</dd>
                </div>
              ))}
              {invoice.paidAt ? (
                <div className="flex flex-wrap gap-x-2">
                  <dt className="text-text-secondary">Paid on</dt>
                  <dd className="break-words text-text-primary">{invoiceDate(invoice.paidAt)}</dd>
                </div>
              ) : null}
            </dl>
            {invoice.adjustments.length > 0 ? (
              <ul aria-label={`Refunds and credits on ${label}`} className="flex flex-col gap-1">
                {invoice.adjustments.map((adjustment, index) => (
                  <li key={index} className="break-words rounded-lg bg-surface-subtle px-3 py-2 text-text-primary">
                    {invoiceAdjustmentLine(adjustment)}
                  </li>
                ))}
              </ul>
            ) : null}
            {actions ? actions(invoice, label) : null}
          </li>
        );
      })}
    </ul>
  );
}
