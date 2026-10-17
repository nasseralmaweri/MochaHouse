import type { Metadata } from "next";
import Link from "next/link";
import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { listPlatformComplimentary } from "@/lib/platform/tenants-api";
import {
  COMPLIMENTARY_FINISH_LABELS,
  COMPLIMENTARY_STATUS_LABELS,
  grantAttention,
  grantEnd,
} from "@/lib/platform/complimentary";

export const metadata: Metadata = {
  title: "Complimentary · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

// SC3e-2 — every open complimentary arrangement (and those finished in the
// last 30 days): what each business gets, until when, who granted it, and
// what needs attention. Changes are made on the business's page.
export default async function PlatformComplimentaryPage() {
  const result = await listPlatformComplimentary();
  return (
    <div className="flex flex-col gap-6">
      <Link href="/platform/billing" className="text-sm font-medium text-text-primary underline underline-offset-2">
        Back to billing
      </Link>
      <PlatformPageHeader
        title="Complimentary arrangements"
        description="Businesses using CENTERIVO without being billed. Nothing here charges, refunds or credits anyone."
      />
      {result.state !== "ok" ? (
        <RegistryStatePanel state={result.state} retryHref="/platform/billing/complimentary" />
      ) : (
        <>
          <p className="text-sm text-text-secondary">
            {result.data.legacyComplimentary} complimentary business
            {result.data.legacyComplimentary === 1 ? "" : "es"} with no arrangement on record (Founding, or billing
            never started).
          </p>
          {result.data.grants.length === 0 ? (
            <p className="rounded-2xl border border-border-default bg-surface-card p-5 text-sm text-text-secondary">
              No complimentary arrangements.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {result.data.grants.map((grant) => {
                const attention = grantAttention(grant);
                return (
                  <li key={grant.id} className="flex flex-col gap-1 rounded-2xl border border-border-default bg-surface-card p-5 text-sm">
                    <Link
                      href={`/platform/tenants/${grant.tenantId}`}
                      className="font-semibold text-text-primary underline underline-offset-2"
                    >
                      {grant.businessName}
                    </Link>
                    <p className="text-text-primary">
                      {COMPLIMENTARY_STATUS_LABELS[grant.status]} · {grant.plan.planName} (version {grant.plan.version}) ·{" "}
                      {grantEnd(grant)}
                    </p>
                    <p className="break-words text-text-secondary">
                      Granted by {grant.grantedBy.email}: {grant.reason}
                    </p>
                    {grant.finishCode ? (
                      <p className="text-text-secondary">{COMPLIMENTARY_FINISH_LABELS[grant.finishCode] ?? grant.finishCode}</p>
                    ) : null}
                    {attention ? (
                      <p className="rounded-lg bg-status-warning/10 px-3 py-2 text-text-primary">{attention}</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
