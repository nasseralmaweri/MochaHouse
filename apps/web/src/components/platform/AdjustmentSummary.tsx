import Link from "next/link";
import type { PlatformAdjustmentView } from "@mocha-house/contracts";
import {
  ADJUSTMENT_EVENT_LABELS,
  ADJUSTMENT_FAILURE_LABELS,
  ADJUSTMENT_KIND_LABELS,
  ADJUSTMENT_STATUS_LABELS,
  approvalsLabel,
  money,
} from "@/lib/platform/adjustments";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

// SC3e-3 — one refund or credit: what, how much (the payment provider's own
// amounts), why, who asked and who decided, and its full history.
export function AdjustmentSummary({
  view,
  linkTitle = false,
  showHistory = false,
}: {
  view: PlatformAdjustmentView;
  linkTitle?: boolean;
  showHistory?: boolean;
}) {
  const title = `${ADJUSTMENT_KIND_LABELS[view.kind]} · ${money(view.totalMinorUnits, view.currency)}`;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="font-semibold text-text-primary">
        {linkTitle ? (
          <Link href={`/platform/billing/adjustments/${view.id}`} className="underline underline-offset-2">
            {title}
          </Link>
        ) : (
          title
        )}
      </p>
      <p className="text-text-primary">
        {ADJUSTMENT_STATUS_LABELS[view.status]}
        {view.origin === "CENTERIVO" && view.status === "PENDING_APPROVAL" ? ` · ${approvalsLabel(view)}` : ""}
      </p>
      {view.origin === "EXTERNAL" ? (
        <p className="rounded-lg bg-status-warning/10 px-3 py-2 text-text-primary">
          Made directly at the payment provider, not through CENTERIVO. Recorded for the history only: it was not
          approved here and is never repeated or reversed.
        </p>
      ) : null}
      {view.failureCode ? (
        <p className="rounded-lg bg-status-warning/10 px-3 py-2 text-text-primary">
          {ADJUSTMENT_FAILURE_LABELS[view.failureCode] ?? view.failureCode}
        </p>
      ) : null}
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-text-secondary">Business</dt>
          <dd className="break-words text-text-primary">
            <Link href={`/platform/tenants/${view.tenantId}`} className="underline underline-offset-2">
              {view.businessName}
            </Link>
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-text-secondary">Invoice</dt>
          <dd className="break-words text-text-primary">{view.invoiceNumber ?? "Not numbered"}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-text-secondary">Amount</dt>
          <dd className="break-words text-text-primary">
            {money(view.totalMinorUnits, view.currency)} including {money(view.taxMinorUnits, view.currency)} tax
            {view.scope ? (view.scope === "FULL" ? " (whole invoice)" : " (part of the invoice)") : ""}
          </dd>
        </div>
        {view.annualFullRefund ? (
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-text-secondary">Policy</dt>
            <dd className="text-text-primary">Full refund of an annual period</dd>
          </div>
        ) : null}
        {view.requestedBy ? (
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-text-secondary">Requested by</dt>
            <dd className="break-words text-text-primary">
              {view.requestedBy.email} on {when(view.createdAt)}
            </dd>
          </div>
        ) : null}
        {view.status === "PENDING_APPROVAL" && view.expiresAt ? (
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-text-secondary">Expires</dt>
            <dd className="text-text-primary">{when(view.expiresAt)}</dd>
          </div>
        ) : null}
        {view.reason ? (
          <div className="flex flex-wrap gap-x-2 sm:col-span-2">
            <dt className="text-text-secondary">Reason</dt>
            <dd className="break-words text-text-primary">{view.reason}</dd>
          </div>
        ) : null}
      </dl>
      {view.decisions.length > 0 ? (
        <ul aria-label="Decisions" className="flex flex-col gap-1">
          {view.decisions.map((decision) => (
            <li key={`${decision.operator.id}-${decision.at}`} className="break-words rounded-lg bg-surface-subtle px-3 py-2 text-text-primary">
              {decision.decision === "APPROVED" ? "Approved" : "Rejected"} by {decision.operator.email} on{" "}
              {when(decision.at)}: {decision.note}
            </li>
          ))}
        </ul>
      ) : null}
      {showHistory ? (
        <details className="text-sm" open>
          <summary className="cursor-pointer font-medium text-text-primary">History</summary>
          <ol className="mt-2 flex flex-col gap-1">
            {view.events.map((event, index) => (
              <li key={index} className="break-words text-text-secondary">
                {when(event.at)} — {ADJUSTMENT_EVENT_LABELS[event.type] ?? event.type}
                {event.code ? ` (${ADJUSTMENT_FAILURE_LABELS[event.code] ?? event.code})` : ""}
                {event.actorEmail ? ` · ${event.actorEmail}` : ""}
                {event.note ? `: ${event.note}` : ""}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}
