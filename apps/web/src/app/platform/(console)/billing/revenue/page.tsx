import type { Metadata } from "next";
import Link from "next/link";
import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { RevenueReport } from "@/components/platform/RevenueReport";
import { SELECT } from "@/components/platform/SubscriptionPanel";
import { getPlatformRevenueReport } from "@/lib/platform/tenants-api";
import { getPlatformSession } from "@/lib/platform-auth/session";
import { isMonth, monthLabel, monthOptions, periodHref, periodParams } from "@/lib/platform/revenue";

export const metadata: Metadata = {
  title: "Revenue · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

// SC3f — CENTERIVO SaaS revenue reporting (billing.reports.view). Only what
// businesses pay CENTERIVO — never a restaurant's sales or its customers'
// payments.
export default async function PlatformRevenuePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[]; to?: string | string[] }>;
}) {
  const period = periodParams(await searchParams);
  const session = await getPlatformSession();
  const permitted = session.state === "signed-in" && session.permissions.includes("billing.reports.view");
  const header = (
    <>
      <Link href="/platform/billing" className="text-sm font-medium text-text-primary underline underline-offset-2">
        Back to billing
      </Link>
      <PlatformPageHeader
        title="Revenue reporting"
        description="CENTERIVO subscription revenue only. Never a restaurant's sales, orders or customer payments."
      />
    </>
  );
  if (!permitted) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <p className="rounded-2xl border border-border-default bg-surface-card p-5 text-sm text-text-secondary">
          Revenue reporting needs the billing.reports.view permission. Ask a CENTERIVO administrator.
        </p>
      </div>
    );
  }
  const result = await getPlatformRevenueReport(period);
  const options = monthOptions(new Date());
  const invalid = result.state === "invalid";
  return (
    <div className="flex flex-col gap-6">
      {header}
      <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Reporting period">
        {invalid ? (
          <p id="period-error" role="alert" className="w-full rounded-lg bg-status-error/10 px-3 py-2 text-sm text-status-error">
            That period can&apos;t be shown: &quot;From&quot; must be no later than &quot;To&quot;, the period at most 24
            months, and not in the future. Choose the months again.
          </p>
        ) : null}
        <label className="flex flex-col gap-1 text-sm text-text-primary">
          From
          <select
            name="from"
            defaultValue={isMonth(period.from) ? period.from : options[11]}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? "period-error period-help" : "period-help"}
            className={SELECT}
          >
            {options.map((month) => (
              <option key={month} value={month}>
                {monthLabel(month)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-text-primary">
          To
          <select
            name="to"
            defaultValue={isMonth(period.to) ? period.to : options[0]}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? "period-error period-help" : "period-help"}
            className={SELECT}
          >
            {options.map((month) => (
              <option key={month} value={month}>
                {monthLabel(month)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="inline-flex min-h-11 items-center rounded-lg border border-border-default px-4 text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
        >
          Show period
        </button>
        <p id="period-help" className="w-full text-xs text-text-secondary">
          Up to 24 months, in UTC calendar months. Until live billing is approved, figures come from Stripe Test Mode.
        </p>
      </form>
      {result.state === "ok" ? (
        <RevenueReport report={result.data} />
      ) : invalid ? null : (
        <RegistryStatePanel state={result.state} retryHref={periodHref(period)} />
      )}
    </div>
  );
}
