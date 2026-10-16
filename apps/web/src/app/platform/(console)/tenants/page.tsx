import type { Metadata } from "next";
import Link from "next/link";
import { platformPrimaryButtonClassName } from "@/components/platform/PlatformAuthFrame";
import {
  PlatformEmptyState,
  PlatformPageHeader,
} from "@/components/platform/PlatformCards";
import { RegistryResultsStatus } from "@/components/platform/RegistryResultsStatus";
import {
  RegistryPagination,
  RegistryStatePanel,
  TenantFilters,
  TenantStatusBadge,
} from "@/components/platform/TenantRegistry";
import { listPlatformTenants } from "@/lib/platform/tenants-api";
import {
  SUSPENSION_REASON_LABELS,
  TENANT_PAGE_SIZE,
  emptyListKind,
  type EmptyListKind,
  formatRegistryDate,
  pageWindow,
  parseTenantListFilters,
  tenantListHref,
} from "@/lib/platform/tenant-registry";

const EMPTY_TITLES: Record<EmptyListKind, string> = {
  "no-matches": "No businesses match these filters",
  "past-last-page": "No businesses on this page",
  "no-businesses": "No businesses yet",
};

export const metadata: Metadata = {
  title: "Tenants · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

// SC1c — every business on CENTERIVO, from the tenant registry
// API: search, status filter, paging. Oldest business first, so the first
// business on the platform (Mocha House, Tenant #1) leads. Real records
// only; nothing here changes a business.
export default async function PlatformTenantsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { filters, searchError } = parseTenantListFilters(await searchParams);
  const header = (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <PlatformPageHeader
        title="Tenants"
        description="Every business on CENTERIVO, oldest first. Status changes arrive in a later release."
      />
      {/* SC1d — provisioning. */}
      <Link href="/platform/tenants/new" className={platformPrimaryButtonClassName}>
        Add a business
      </Link>
    </div>
  );

  if (searchError) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <TenantFilters filters={filters} searchError={searchError} />
      </div>
    );
  }

  const result = await listPlatformTenants(filters);
  if (result.state !== "ok") {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <RegistryStatePanel
          state={result.state}
          retryHref={tenantListHref(filters)}
        />
      </div>
    );
  }

  const { tenants, total, registry } = result.data;
  const paging = pageWindow(filters.page, TENANT_PAGE_SIZE, total);
  const filtered = Boolean(filters.q || filters.status);

  return (
    <div className="flex flex-col gap-6">
      {header}

      <dl className="grid grid-cols-3 gap-3 sm:max-w-md">
        {[
          ["All", registry.total],
          ["Active", registry.active],
          ["Suspended", registry.suspended],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-2xl border border-border-default bg-surface-card px-4 py-3"
          >
            <dt className="text-xs font-medium text-text-secondary">{label}</dt>
            <dd className="text-xl font-semibold text-text-primary">{value}</dd>
          </div>
        ))}
      </dl>

      <TenantFilters filters={filters} searchError={null} />

      <RegistryResultsStatus
        resultKey={tenantListHref(filters)}
        message={
          total === 0
            ? "No businesses to show."
            : `Showing ${paging.from}–${paging.to} of ${total} ${
                total === 1 ? "business" : "businesses"
              }${filtered ? " matching these filters" : ""}.`
        }
      />

      {tenants.length === 0 ? (
        <PlatformEmptyState title={EMPTY_TITLES[emptyListKind(filtered, total)]}>
          {filtered ? (
            <Link
              href="/platform/tenants"
              className="font-medium text-text-primary underline underline-offset-4"
            >
              Clear the search and filters
            </Link>
          ) : total > 0 ? (
            <Link
              href={tenantListHref({ ...filters, page: 1 })}
              className="font-medium text-text-primary underline underline-offset-4"
            >
              Go to the first page
            </Link>
          ) : (
            "Businesses appear here once they are on CENTERIVO."
          )}
        </PlatformEmptyState>
      ) : (
        <>
          {/* Desktop: a table. */}
          <div className="hidden overflow-hidden rounded-2xl border border-border-default bg-surface-card md:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Businesses on CENTERIVO</caption>
              <thead className="border-b border-border-default bg-surface-subtle text-xs uppercase tracking-wide text-text-secondary">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Business</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Locations</th>
                  <th scope="col" className="px-4 py-3 font-medium">On CENTERIVO since</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-default">
                {tenants.map((tenant) => (
                  <tr key={tenant.id} className="hover:bg-surface-subtle">
                    <td className="px-4 py-3">
                      <Link
                        href={`/platform/tenants/${tenant.id}`}
                        className="font-medium text-text-primary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                      >
                        {tenant.name}
                      </Link>
                      <p className="font-mono text-xs text-text-secondary">
                        {tenant.slug}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <TenantStatusBadge status={tenant.status} />
                      {tenant.suspensionReason ? (
                        <p className="mt-1 text-xs text-text-secondary">
                          {SUSPENSION_REASON_LABELS[tenant.suspensionReason]}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-text-primary">
                      {tenant.locationCount}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {formatRegistryDate(tenant.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: one card per business. */}
          <ul className="flex flex-col gap-3 md:hidden">
            {tenants.map((tenant) => (
              <li key={tenant.id}>
                <Link
                  href={`/platform/tenants/${tenant.id}`}
                  className="flex flex-col gap-2 rounded-2xl border border-border-default bg-surface-card p-4 hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-text-primary">
                        {tenant.name}
                      </span>
                      <span className="block truncate font-mono text-xs text-text-secondary">
                        {tenant.slug}
                      </span>
                    </span>
                    <TenantStatusBadge status={tenant.status} />
                  </span>
                  <span className="text-xs text-text-secondary">
                    {tenant.locationCount}{" "}
                    {tenant.locationCount === 1 ? "location" : "locations"} ·
                    since {formatRegistryDate(tenant.createdAt)}
                    {tenant.suspensionReason
                      ? ` · ${SUSPENSION_REASON_LABELS[tenant.suspensionReason]}`
                      : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <RegistryPagination
        paging={paging}
        label="Tenant pages"
        hrefFor={(page) => tenantListHref({ ...filters, page })}
      />
    </div>
  );
}
