import type { Metadata } from "next";
import Link from "next/link";
import { PLATFORM_REGISTRATION_FILTERS } from "@mocha-house/contracts";
import { PlatformEmptyState, PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryPagination, RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { FilterLinks, NoPermissionPanel } from "@/components/platform/OnboardingFilters";
import { platformInputClassName } from "@/components/platform/PlatformAuthFrame";
import { getPlatformSession } from "@/lib/platform-auth/session";
import { listRegistrations } from "@/lib/platform/tenants-api";
import { pageWindow } from "@/lib/platform/tenant-registry";
import {
  ONBOARDING_VIEW_PERMISSION,
  REGISTRATION_FILTER_LABEL,
  REGISTRATION_ISSUE_LABEL,
  REGISTRATION_STATUS_LABEL,
  formatPlatformTime,
  registrationFilters,
  registrationQuery,
  type RegistrationFilters,
} from "@/lib/platform/onboarding";

export const metadata: Metadata = {
  title: "Registrations · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

const PAGE_SIZE = 20;
const LINK =
  "font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const BUTTON =
  "inline-flex min-h-11 items-center rounded-lg border border-border-default px-4 text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

function href(filters: RegistrationFilters): string {
  const query = registrationQuery(filters, PAGE_SIZE);
  return `/platform/onboarding/registrations?${query}`;
}

// SC4e — every owner registration (onboarding.view; each view is audited by
// the API). An unverified email is masked by the API; codes, passwords and
// login identifiers are never sent here.
export default async function PlatformRegistrationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getPlatformSession();
  const permitted =
    session.state === "signed-in" && session.permissions.includes(ONBOARDING_VIEW_PERMISSION);
  const filters = registrationFilters(await searchParams);
  const header = (
    <>
      <Link href="/platform/onboarding" className={LINK}>
        Back to onboarding
      </Link>
      <PlatformPageHeader
        title="Registrations"
        description="Owner sign-ups, newest first. Unverified email addresses are partly hidden. Times are in UTC."
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
  const result = await listRegistrations(registrationQuery(filters, PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6">
      {header}
      <FilterLinks
        label="Registration status"
        options={PLATFORM_REGISTRATION_FILTERS}
        current={filters.filter}
        hrefFor={(filter) => href({ ...filters, filter, page: 1 })}
        labels={REGISTRATION_FILTER_LABEL}
      />
      <form method="get" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="filter" value={filters.filter} />
        <label className="flex flex-col gap-1 text-sm text-text-primary">
          Registered from
          <input type="date" name="createdFrom" defaultValue={filters.createdFrom} className={platformInputClassName} />
        </label>
        <label className="flex flex-col gap-1 text-sm text-text-primary">
          Registered to
          <input type="date" name="createdTo" defaultValue={filters.createdTo} className={platformInputClassName} />
        </label>
        <button type="submit" className={BUTTON}>
          Apply dates
        </button>
        {filters.createdFrom || filters.createdTo ? (
          <Link href={href({ ...filters, createdFrom: "", createdTo: "", page: 1 })} className={LINK}>
            Clear dates
          </Link>
        ) : null}
      </form>

      {result.state !== "ok" ? (
        <RegistryStatePanel state={result.state} retryHref={href(filters)} />
      ) : result.data.items.length === 0 ? (
        filters.filter === "all" && !filters.createdFrom && !filters.createdTo ? (
          <PlatformEmptyState title="No registrations yet">
            Business owners who sign up themselves will appear here.
          </PlatformEmptyState>
        ) : (
          <PlatformEmptyState title="No registrations match">
            Try another status or date range.
          </PlatformEmptyState>
        )
      ) : (
        <>
          <p role="status" className="text-sm text-text-secondary">
            {result.data.total} registration{result.data.total === 1 ? "" : "s"}
          </p>
          <ul className="flex flex-col gap-3">
            {result.data.items.map((row) => (
              <li key={row.id} className="flex flex-col gap-2 rounded-2xl border border-border-default bg-surface-card p-5 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-col">
                    <span className="break-all font-semibold text-text-primary">{row.email}</span>
                    {row.emailMasked ? (
                      <span className="text-xs text-text-muted">Partly hidden until verified</span>
                    ) : null}
                  </span>
                  <span className="rounded-full bg-surface-subtle px-2.5 py-1 text-xs font-medium text-text-secondary">
                    {REGISTRATION_STATUS_LABEL[row.status]}
                  </span>
                </div>
                {row.issue ? (
                  <p className="font-medium text-status-warning">{REGISTRATION_ISSUE_LABEL[row.issue]}</p>
                ) : null}
                <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[11rem_1fr]">
                  <dt className="text-text-secondary">Registered</dt>
                  <dd className="text-text-primary">{formatPlatformTime(row.createdAt)}</dd>
                  <dt className="text-text-secondary">Verified</dt>
                  <dd className="text-text-primary">{formatPlatformTime(row.verifiedAt)}</dd>
                  {row.codeExpiresAt ? (
                    <>
                      <dt className="text-text-secondary">Latest code expires</dt>
                      <dd className="text-text-primary">{formatPlatformTime(row.codeExpiresAt)}</dd>
                    </>
                  ) : null}
                  <dt className="text-text-secondary">Codes sent (24 h)</dt>
                  <dd className="text-text-primary">{row.codesSent}</dd>
                  <dt className="text-text-secondary">Failed attempts</dt>
                  <dd className="text-text-primary">{row.failedAttempts}</dd>
                  <dt className="text-text-secondary">Business</dt>
                  <dd className="text-text-primary">
                    {row.business ? (
                      <>
                        <Link href={`/platform/tenants/${row.business.id}`} className={LINK}>
                          {row.business.name || "Open business"}
                        </Link>{" "}
                        <span className="text-text-secondary">created {formatPlatformTime(row.business.createdAt)}</span>
                      </>
                    ) : (
                      "Not created"
                    )}
                  </dd>
                </dl>
              </li>
            ))}
          </ul>
          <RegistryPagination
            paging={pageWindow(result.data.page, result.data.pageSize, result.data.total)}
            hrefFor={(page) => href({ ...filters, page })}
            label="Registration pages"
          />
        </>
      )}
    </div>
  );
}
