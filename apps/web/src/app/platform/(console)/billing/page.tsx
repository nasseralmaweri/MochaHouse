import type { Metadata } from "next";
import Link from "next/link";
import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { RunReconciliation } from "@/components/platform/ReconciliationControls";
import { CASE_LABELS } from "@/lib/platform/billing-case-labels";
import {
  getPlatformBillingOverview,
  listPlatformReconciliationCases,
} from "@/lib/platform/tenants-api";
import { BillingOverviewCards } from "@/components/platform/BillingOverviewCards";

export const metadata: Metadata = {
  title: "Billing · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

// SC3b — review-only billing reconciliation (Stripe test mode). Running it,
// or acting on a case, never moves money. SC3e-2 — each case opens its own
// page (recheck, schedule release, close with an outcome).
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
        description="Review where our billing records and the payment provider disagree. Nothing on this page charges, refunds or changes a subscription."
      />
      {overview.state === "ok" ? (
        <BillingOverviewCards overview={overview.data} caseLabels={CASE_LABELS} />
      ) : (
        <RegistryStatePanel state={overview.state} retryHref="/platform/billing" />
      )}
      <RunReconciliation />
      <nav aria-label="Billing management" className="flex flex-wrap gap-x-6 text-sm">
        <Link
          href="/platform/billing/complimentary"
          className="inline-flex min-h-11 items-center font-medium text-text-primary underline underline-offset-2"
        >
          Complimentary arrangements
        </Link>
        <Link
          href="/platform/billing/revenue"
          className="inline-flex min-h-11 items-center font-medium text-text-primary underline underline-offset-2"
        >
          Revenue reporting
        </Link>
        <Link
          href="/platform/billing/payment-setup"
          className="inline-flex min-h-11 items-center font-medium text-text-primary underline underline-offset-2"
        >
          Awaiting payment setup
        </Link>
        <Link
          href="/platform/billing/adjustments"
          className="inline-flex min-h-11 items-center font-medium text-text-primary underline underline-offset-2"
        >
          Refunds and credits
        </Link>
        <Link
          href="/platform/operators"
          className="inline-flex min-h-11 items-center font-medium text-text-primary underline underline-offset-2"
        >
          Operator permissions
        </Link>
      </nav>
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
          Closed
        </Link>
      </nav>
      {cases.state !== "ok" ? (
        <RegistryStatePanel
          state={cases.state}
          retryHref={status === "OPEN" ? "/platform/billing" : "/platform/billing?status=RESOLVED"}
        />
      ) : cases.data.cases.length === 0 ? (
        <p className="rounded-2xl border border-border-default bg-surface-card p-5 text-sm text-text-secondary">
          {status === "OPEN" ? "Nothing to review." : "No closed cases yet."}
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
                    ? ` · Closed ${new Date(item.resolvedAt).toLocaleString("en-US")}`
                    : ""}
                </p>
              </div>
              <Link
                href={`/platform/billing/cases/${item.id}`}
                className="inline-flex min-h-11 items-center self-start text-sm font-medium text-text-primary underline underline-offset-2"
                aria-label={`${item.status === "OPEN" ? "Review" : "View"} case: ${CASE_LABELS[item.kind] ?? item.kind}`}
              >
                {item.status === "OPEN" ? "Review case" : "View case"}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
