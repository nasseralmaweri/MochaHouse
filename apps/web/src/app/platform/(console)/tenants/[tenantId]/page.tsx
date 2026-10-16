import type { Metadata } from "next";
import Link from "next/link";
import {
  PlatformCard,
  PlatformEmptyState,
  PlatformPageHeader,
} from "@/components/platform/PlatformCards";
import {
  RegistryPagination,
  RegistryStatePanel,
  TenantStatusBadge,
} from "@/components/platform/TenantRegistry";
import { TenantLifecyclePanel } from "@/components/platform/TenantLifecyclePanel";
import {
  getPlatformTenant,
  getPlatformTenantLifecycle,
  listPlatformTenantLocations,
} from "@/lib/platform/tenants-api";
import {
  LOCATION_PAGE_SIZE,
  SUSPENSION_REASON_LABELS,
  formatRegistryDate,
  isTenantId,
  pageWindow,
  parsePage,
} from "@/lib/platform/tenant-registry";

export const metadata: Metadata = {
  title: "Tenant · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

function BackLink() {
  return (
    <Link
      href="/platform/tenants"
      className="w-fit text-sm font-medium text-text-secondary underline-offset-4 hover:text-text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
    >
      ← All tenants
    </Link>
  );
}

// SC1c — one business from the tenant registry: its registry record,
// status, and location summary. No customers, orders, payments or staff
// records are read or shown. SC1e — plus its lifecycle (status changes and
// the first owner, operator-only), changed only through the panel's
// server actions.
export default async function PlatformTenantPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tenantId } = await params;
  const locationPage = parsePage((await searchParams).page);

  if (!isTenantId(tenantId)) {
    return (
      <div className="flex flex-col gap-6">
        <BackLink />
        <PlatformPageHeader title="Tenant" />
        <RegistryStatePanel state="not-found" />
      </div>
    );
  }

  const [detail, locations, lifecycle] = await Promise.all([
    getPlatformTenant(tenantId),
    listPlatformTenantLocations(tenantId, locationPage),
    getPlatformTenantLifecycle(tenantId),
  ]);
  if (detail.state !== "ok") {
    return (
      <div className="flex flex-col gap-6">
        <BackLink />
        <PlatformPageHeader title="Tenant" />
        <RegistryStatePanel
          state={detail.state}
          retryHref={`/platform/tenants/${tenantId}`}
        />
      </div>
    );
  }

  const { tenant, locations: counts } = detail.data;
  const hrefForPage = (page: number) =>
    page > 1
      ? `/platform/tenants/${tenant.id}?page=${page}`
      : `/platform/tenants/${tenant.id}`;

  return (
    <div className="flex flex-col gap-6">
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PlatformPageHeader title={tenant.name} />
        <TenantStatusBadge status={tenant.status} />
      </div>

      <div
        className={
          lifecycle.state === "ok" ? "grid gap-4" : "grid gap-4 lg:grid-cols-2"
        }
      >
        <PlatformCard title="Business">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-text-secondary">Name</dt>
            <dd className="break-words text-text-primary">{tenant.name}</dd>
            <dt className="text-text-secondary">Slug</dt>
            <dd className="break-all font-mono text-text-primary">{tenant.slug}</dd>
            <dt className="text-text-secondary">Tenant ID</dt>
            <dd className="break-all font-mono text-xs leading-5 text-text-primary">
              {tenant.id}
            </dd>
            <dt className="text-text-secondary">On CENTERIVO since</dt>
            <dd className="text-text-primary">{formatRegistryDate(tenant.createdAt)}</dd>
            <dt className="text-text-secondary">Last updated</dt>
            <dd className="text-text-primary">{formatRegistryDate(tenant.updatedAt)}</dd>
          </dl>
        </PlatformCard>

        {lifecycle.state !== "ok" ? (
          // SC1e — the lifecycle could not be read: status only, no actions.
          <PlatformCard title="Business status">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-text-secondary">Status</dt>
              <dd>
                <TenantStatusBadge status={tenant.status} />
              </dd>
              {tenant.suspensionReason ? (
                <>
                  <dt className="text-text-secondary">Suspension reason</dt>
                  <dd className="text-text-primary">
                    {SUSPENSION_REASON_LABELS[tenant.suspensionReason]}
                  </dd>
                </>
              ) : null}
            </dl>
            <p className="text-sm text-text-secondary">
              Status changes are unavailable right now.{" "}
              <Link
                href={`/platform/tenants/${tenant.id}`}
                className="font-medium text-text-primary underline underline-offset-4"
              >
                Reload
              </Link>
            </p>
          </PlatformCard>
        ) : null}
      </div>

      {lifecycle.state === "ok" ? (
        <section aria-labelledby="tenant-lifecycle" className="flex flex-col gap-4">
          <h2 id="tenant-lifecycle" className="text-lg font-semibold text-text-primary">
            Lifecycle
          </h2>
          <TenantLifecyclePanel lifecycle={lifecycle.data} slug={tenant.slug} />
        </section>
      ) : null}

      <section aria-labelledby="tenant-locations" className="flex flex-col gap-4">
        <h2
          id="tenant-locations"
          className="text-lg font-semibold text-text-primary"
        >
          Locations
        </h2>
        <dl className="grid grid-cols-3 gap-3 sm:max-w-lg">
          {[
            ["Total", counts.total],
            ["Active", counts.active],
            ["Taking digital orders", counts.digitalOrderingEnabled],
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

        {locations.state !== "ok" ? (
          <RegistryStatePanel
            state={locations.state}
            retryHref={hrefForPage(locationPage)}
          />
        ) : locations.data.locations.length === 0 ? (
          <PlatformEmptyState
            title={counts.total === 0 ? "No locations yet" : "No locations on this page"}
          >
            {counts.total === 0 ? (
              "This business has not added a location."
            ) : (
              <Link
                href={hrefForPage(1)}
                className="font-medium text-text-primary underline underline-offset-4"
              >
                Go to the first page
              </Link>
            )}
          </PlatformEmptyState>
        ) : (
          <>
            <ul className="divide-y divide-border-default overflow-hidden rounded-2xl border border-border-default bg-surface-card">
              {locations.data.locations.map((location) => (
                <li
                  key={location.id}
                  className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0">
                    <span className="block font-medium text-text-primary">
                      {location.name}
                    </span>
                    <span className="block truncate font-mono text-xs text-text-secondary">
                      {location.slug}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-2 text-xs text-text-secondary">
                    <span className="rounded-full border border-border-default px-2.5 py-0.5">
                      {location.isActive ? "Active" : "Inactive"}
                    </span>
                    <span className="rounded-full border border-border-default px-2.5 py-0.5">
                      {location.isDigitalOrderingEnabled
                        ? "Digital ordering on"
                        : "Digital ordering off"}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <RegistryPagination
              paging={pageWindow(
                locationPage,
                LOCATION_PAGE_SIZE,
                locations.data.total,
              )}
              label="Location pages"
              hrefFor={hrefForPage}
            />
          </>
        )}
      </section>
    </div>
  );
}
