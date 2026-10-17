import type { Metadata } from "next";
import Link from "next/link";
import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import {
  ResolveCase,
  RunReconciliation,
} from "@/components/platform/ReconciliationControls";
import {
  getPlatformBillingOverview,
  listPlatformReconciliationCases,
} from "@/lib/platform/tenants-api";
import { BillingOverviewCards } from "@/components/platform/BillingOverviewCards";

export const metadata: Metadata = {
  title: "Billing · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

// What each case kind means, in plain words.
const CASE_LABELS: Record<string, string> = {
  STATE_MISMATCH: "Billing status differs from the payment provider",
  PAYMENT_METHOD_NOT_RECORDED: "Payment provider has a payment method we haven't recorded",
  PAYMENT_METHOD_MISSING: "Payment method removed at the payment provider",
  CANCELLATION_MISMATCH: "Scheduled cancellation differs from the payment provider",
  CUSTOMER_MISMATCH: "Provider subscription belongs to another customer",
  CHECKOUT_CUSTOMER_MISMATCH: "Payment setup completed for another customer",
  CHECKOUT_LINKED_ELSEWHERE: "Payment setup completed after another subscription was linked",
  CHECKOUT_NOT_LINKED: "Payment setup completed but was never linked",
  UNEXPECTED_TRIAL: "Provider started a trial we did not offer, or one already used",
  INVOICE_MISMATCH: "Invoice does not belong to this business",
  INVOICE_NOT_PAID: "Payment reported but the invoice is not paid",
  SUBSCRIPTION_MISMATCH: "Provider subscription does not match our records",
  EVENT_NOT_APPLIED: "A billing event could not be applied",
  EVENT_RETRIES_EXHAUSTED: "A billing event kept failing and was set aside",
  UNLINKED_REPLACEMENT: "A restart was created at the payment provider but not linked (see the recovery runbook)",
  CHECKOUT_NOT_RECORDED: "A payment page was created but could not be recorded",
  PROVIDER_UNREADABLE: "The payment provider could not be read",
  SUSPENSION_EXEMPT: "Billing would have suspended a business that is exempt",
  // SC3c-3
  BILLING_CONTACT_MISSING: "No one eligible to receive billing email",
  BILLING_CONTACT_UNVERIFIED:
    "The designated billing contact's email isn't verified (or the verification expired); they need to sign in again",
  BILLING_NOTIFICATION_FAILED: "A billing email could not be sent",
  // SC3d
  PRICE_MISMATCH: "The payment provider bills a different price than our records",
  PLAN_CHANGE_AMOUNT_MISMATCH:
    "A plan change was paid, but the amount differs from the price the business confirmed",
  UPGRADE_PAID_NOT_APPLIED: "A plan change was paid but not applied",
  PLAN_CHANGE_UNCERTAIN: "A plan change needs checking against the payment provider",
  EXTENSION_ENDED_BY_PROVIDER:
    "The payment provider ended a subscription during extra time an operator gave",
};

// SC3b — review-only billing reconciliation (Stripe test mode). Running it,
// or marking a case reviewed, never moves money or changes a subscription.
export default async function PlatformBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const status = (await searchParams).status === "RESOLVED" ? "RESOLVED" : "OPEN";
  const [cases, overview] = await Promise.all([
    listPlatformReconciliationCases(status),
    getPlatformBillingOverview(),
  ]);
  return (
    <div className="flex flex-col gap-6">
      <PlatformPageHeader
        title="Billing"
        description="Review where our billing records and the payment provider disagree. Nothing here charges, refunds or changes a subscription."
      />
      {overview.state === "ok" ? (
        <BillingOverviewCards overview={overview.data} caseLabels={CASE_LABELS} />
      ) : (
        <RegistryStatePanel state={overview.state} retryHref="/platform/billing" />
      )}
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
