import type { Metadata } from "next";
import Link from "next/link";
import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { AdjustmentSummary } from "@/components/platform/AdjustmentSummary";
import { listPlatformAdjustments } from "@/lib/platform/tenants-api";
import { APPROVAL_POLICY } from "@/lib/platform/adjustments";

export const metadata: Metadata = {
  title: "Refunds and credits · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

// SC3e-3 — refunds and credits on businesses' CENTERIVO subscription
// invoices: open requests (awaiting approval, being carried out, under
// review), or all recent ones. A request is made from the business's invoice.
export default async function PlatformAdjustmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const status = (await searchParams).status === "ALL" ? "ALL" : "OPEN";
  const result = await listPlatformAdjustments(status);
  return (
    <div className="flex flex-col gap-6">
      <Link href="/platform/billing" className="text-sm font-medium text-text-primary underline underline-offset-2">
        Back to billing
      </Link>
      <PlatformPageHeader
        title="Refunds and credits"
        description="CENTERIVO subscription invoices only — never a restaurant's orders or its customers' payments. Stripe test mode."
      />
      <p className="text-sm text-text-secondary">{APPROVAL_POLICY}</p>
      <nav aria-label="Which requests" className="flex gap-4 text-sm">
        <Link
          href="/platform/billing/adjustments"
          aria-current={status === "OPEN" ? "page" : undefined}
          className="inline-flex min-h-11 items-center font-medium text-text-primary underline-offset-4 aria-[current=page]:underline"
        >
          Open
        </Link>
        <Link
          href="/platform/billing/adjustments?status=ALL"
          aria-current={status === "ALL" ? "page" : undefined}
          className="inline-flex min-h-11 items-center font-medium text-text-primary underline-offset-4 aria-[current=page]:underline"
        >
          All recent
        </Link>
      </nav>
      {result.state !== "ok" ? (
        <RegistryStatePanel state={result.state} retryHref="/platform/billing/adjustments" />
      ) : result.data.adjustments.length === 0 ? (
        <p className="rounded-2xl border border-border-default bg-surface-card p-5 text-sm text-text-secondary">
          {status === "OPEN" ? "No open refund or credit requests." : "No refunds or credits yet."}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {result.data.adjustments.map((view) => (
            <li key={view.id} className="rounded-2xl border border-border-default bg-surface-card p-5">
              <AdjustmentSummary view={view} linkTitle />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
