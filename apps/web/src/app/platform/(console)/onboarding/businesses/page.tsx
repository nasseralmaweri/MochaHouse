import type { Metadata } from "next";
import Link from "next/link";
import { PLATFORM_ONBOARDING_FILTERS } from "@mocha-house/contracts";
import { PlatformEmptyState, PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryPagination, RegistryStatePanel, TenantStatusBadge } from "@/components/platform/TenantRegistry";
import { FilterLinks, NoPermissionPanel } from "@/components/platform/OnboardingFilters";
import { platformInputClassName } from "@/components/platform/PlatformAuthFrame";
import { getPlatformSession } from "@/lib/platform-auth/session";
import { listOnboardingBusinesses } from "@/lib/platform/tenants-api";
import { pageWindow } from "@/lib/platform/tenant-registry";
import {
  ONBOARDING_FILTER_LABEL,
  ONBOARDING_VIEW_PERMISSION,
  STEP_COLUMN_LABEL,
  formatPlatformTime,
  onboardingFilters,
  onboardingQuery,
  type OnboardingFilters,
} from "@/lib/platform/onboarding";

export const metadata: Metadata = {
  title: "Setup progress · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

const PAGE_SIZE = 20;
const LINK =
  "font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const BUTTON =
  "inline-flex min-h-11 items-center rounded-lg border border-border-default px-4 text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

function href(filters: OnboardingFilters): string {
  return `/platform/onboarding/businesses?${onboardingQuery(filters, PAGE_SIZE)}`;
}

// SC4e — each self-service business's getting-started progress: the same
// steps the business sees in its own checklist (SC4d), computed live by the
// API. Read-only; the links go to the existing business and billing pages.
export default async function PlatformOnboardingBusinessesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getPlatformSession();
  const permitted =
    session.state === "signed-in" && session.permissions.includes(ONBOARDING_VIEW_PERMISSION);
  const filters = onboardingFilters(await searchParams);
  const header = (
    <>
      <Link href="/platform/onboarding" className={LINK}>
        Back to onboarding
      </Link>
      <PlatformPageHeader
        title="Setup progress"
        description="Businesses created by their owners, most recent first, with the getting-started steps each one sees. Finishing setup does not make a business publicly live."
      />
    </>
  );
  if (!permitted) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <NoPermissionPanel permission={ONBOARDING_VIEW_PERMISSION} />
      </div>
    );
  }
  const result = await listOnboardingBusinesses(onboardingQuery(filters, PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6">
      {header}
      <FilterLinks
        label="Setup filter"
        options={PLATFORM_ONBOARDING_FILTERS}
        current={filters.filter}
        hrefFor={(filter) => href({ ...filters, filter, page: 1 })}
        labels={ONBOARDING_FILTER_LABEL}
      />
      <form method="get" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="filter" value={filters.filter} />
        <label className="flex flex-col gap-1 text-sm text-text-primary">
          Stuck after (days)
          <input
            type="number"
            name="stuckDays"
            min={1}
            max={90}
            defaultValue={filters.stuckDays}
            className={`${platformInputClassName} w-28`}
          />
        </label>
        <button type="submit" className={BUTTON}>
          Apply
        </button>
      </form>

      {result.state !== "ok" ? (
        <RegistryStatePanel state={result.state} retryHref={href(filters)} />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              ["Businesses", result.data.summary.businesses],
              ["Setup complete", result.data.summary.complete],
              ["Awaiting payment", result.data.summary.awaitingPayment],
              [`Stuck (${result.data.stuckDays}+ days)`, result.data.summary.stuck],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl border border-border-default bg-surface-card p-4">
                <dt className="text-text-secondary">{label}</dt>
                <dd className="text-xl font-semibold text-text-primary">{value}</dd>
              </div>
            ))}
          </dl>
          {result.data.truncated ? (
            <p role="note" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
              Only the {result.data.scanLimit.toLocaleString("en-US")} most recent businesses are included.
            </p>
          ) : null}
          {result.data.items.length === 0 ? (
            <PlatformEmptyState title="No businesses match">
              Try another filter.
            </PlatformEmptyState>
          ) : (
            <>
              <p role="status" className="text-sm text-text-secondary">
                {result.data.total} business{result.data.total === 1 ? "" : "es"}
              </p>
              <ul className="flex flex-col gap-3">
                {result.data.items.map((row) => {
                  const awaitingPayment = row.steps.some((step) => step.key === "billing" && !step.done);
                  return (
                    <li key={row.tenantId} className="flex flex-col gap-3 rounded-2xl border border-border-default bg-surface-card p-5 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Link href={`/platform/tenants/${row.tenantId}`} className={LINK}>
                          {row.name}
                        </Link>
                        <div className="flex flex-wrap items-center gap-2">
                          {row.stuck ? (
                            <span className="rounded-full bg-status-warning/10 px-2.5 py-1 text-xs font-medium text-status-warning">
                              Stuck
                            </span>
                          ) : null}
                          <TenantStatusBadge status={row.tenantStatus} />
                        </div>
                      </div>
                      <p className="text-text-secondary">
                        {row.setupComplete ? "Setup complete (not publicly live yet)" : `${row.completedCount} of ${row.totalCount} steps done`}
                        {" · "}business created {formatPlatformTime(row.businessCreatedAt)}
                      </p>
                      <ul aria-label={`Setup steps for ${row.name}`} className="flex flex-wrap gap-2">
                        {row.steps.map((step) => (
                          <li
                            key={step.key}
                            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                              step.done
                                ? "bg-status-success/10 text-status-success"
                                : "bg-surface-subtle text-text-secondary"
                            }`}
                          >
                            <span aria-hidden="true">{step.done ? "✓ " : "○ "}</span>
                            {STEP_COLUMN_LABEL[step.key]}
                            <span className="sr-only">{step.done ? ": done" : ": not done"}</span>
                          </li>
                        ))}
                      </ul>
                      {awaitingPayment ? (
                        <Link href="/platform/billing/payment-setup" className={LINK}>
                          See awaiting payment setup
                        </Link>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              <RegistryPagination
                paging={pageWindow(result.data.page, result.data.pageSize, result.data.total)}
                hrefFor={(page) => href({ ...filters, page })}
                label="Business pages"
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
