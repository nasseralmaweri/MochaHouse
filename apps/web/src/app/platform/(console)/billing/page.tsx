import type { Metadata } from "next";
import Link from "next/link";
import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import {
  ResolveCase,
  RunReconciliation,
} from "@/components/platform/ReconciliationControls";
import { listPlatformReconciliationCases } from "@/lib/platform/tenants-api";

export const metadata: Metadata = {
  title: "Billing · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

// What each case kind means, in plain words.
const CASE_LABELS: Record<string, string> = {
  STATE_MISMATCH: "Billing status differs from the payment provider",
  PAYMENT_METHOD_MISMATCH: "Payment method differs from the payment provider",
  CANCELLATION_MISMATCH: "Scheduled cancellation differs from the payment provider",
  CUSTOMER_MISMATCH: "Provider subscription belongs to another customer",
  CHECKOUT_CUSTOMER_MISMATCH: "Payment setup completed for another customer",
  CHECKOUT_LINKED_ELSEWHERE: "Payment setup completed after another subscription was linked",
  CHECKOUT_NOT_LINKED: "Payment setup completed but was never linked",
  UNEXPECTED_TRIAL: "Provider started a trial we did not offer",
  INVOICE_MISMATCH: "Invoice does not belong to this business",
  INVOICE_NOT_PAID: "Payment reported but the invoice is not paid",
  SUBSCRIPTION_MISMATCH: "Provider subscription does not match our records",
  EVENT_NOT_APPLIED: "A billing event could not be applied",
  PROVIDER_UNREADABLE: "The payment provider could not be read",
};

// SC3b — review-only billing reconciliation (Stripe test mode). Running it,
// or marking a case reviewed, never moves money or changes a subscription.
export default async function PlatformBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const status = (await searchParams).status === "RESOLVED" ? "RESOLVED" : "OPEN";
  const cases = await listPlatformReconciliationCases(status);
  return (
    <div className="flex flex-col gap-6">
      <PlatformPageHeader
        title="Billing"
        description="Review where our billing records and the payment provider disagree. Nothing here charges, refunds or changes a subscription."
      />
      <RunReconciliation />
      <nav aria-label="Case status" className="flex gap-4 text-sm">
        <Link
          href="/platform/billing"
          aria-current={status === "OPEN" ? "page" : undefined}
          className="font-medium text-text-primary underline-offset-4 aria-[current=page]:underline"
        >
          To review
        </Link>
        <Link
          href="/platform/billing?status=RESOLVED"
          aria-current={status === "RESOLVED" ? "page" : undefined}
          className="font-medium text-text-primary underline-offset-4 aria-[current=page]:underline"
        >
          Reviewed
        </Link>
      </nav>
      {cases.state !== "ok" ? (
        <RegistryStatePanel
          state={cases.state}
          retryHref={status === "OPEN" ? "/platform/billing" : "/platform/billing?status=RESOLVED"}
        />
      ) : cases.data.cases.length === 0 ? (
        <p className="rounded-2xl border border-border-default bg-surface-card p-5 text-sm text-text-secondary">
          {status === "OPEN" ? "Nothing to review." : "No reviewed cases yet."}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {cases.data.cases.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-2 rounded-2xl border border-border-default bg-surface-card p-5 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="flex flex-col gap-1 text-sm">
                <p className="font-semibold text-text-primary">
                  {CASE_LABELS[item.kind] ?? item.kind}
                </p>
                {item.tenantId ? (
                  <Link
                    href={`/platform/tenants/${item.tenantId}`}
                    className="text-text-primary underline underline-offset-2"
                  >
                    {item.businessName ?? "Business"}
                  </Link>
                ) : null}
                {item.detail ? <p className="text-text-secondary">{item.detail}</p> : null}
                <p className="text-xs text-text-secondary">
                  Opened {new Date(item.createdAt).toLocaleString("en-US")}
                  {item.resolvedAt
                    ? ` · Reviewed ${new Date(item.resolvedAt).toLocaleString("en-US")}`
                    : ""}
                </p>
              </div>
              {item.status === "OPEN" ? <ResolveCase caseId={item.id} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
