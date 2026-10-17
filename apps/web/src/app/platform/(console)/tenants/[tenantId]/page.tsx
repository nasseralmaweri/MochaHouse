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
import { SubscriptionPanel } from "@/components/platform/SubscriptionPanel";
import { BillingPanel } from "@/components/platform/BillingPanel";
import { BillingOperationsPanel } from "@/components/platform/BillingOperationsPanel";
import { PaymentSetupPanel } from "@/components/platform/PaymentSetupPanel";
import { InvoiceList } from "@/components/billing/InvoiceList";
import { ComplimentaryPanel } from "@/components/platform/ComplimentaryPanel";
import { AdjustmentSummary } from "@/components/platform/AdjustmentSummary";
import { getPlatformSession } from "@/lib/platform-auth/session";
import { holds } from "@/lib/platform/complimentary";
import { pageCursor } from "@/lib/admin/billing-history";
import { assignableVersions } from "@/lib/platform/subscriptions";
import {
  getPlatformTenant,
  getPlatformTenantLifecycle,
  getPlatformTenantBilling,
  getPlatformTenantInvoices,
  getPlatformTenantComplimentary,
  getPlatformTenantSubscription,
  listPlatformTenantAdjustments,
  listPlatformPlans,
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
  const query = await searchParams;
  const locationPage = parsePage(query.page);
  // SC3e-1 — the invoice history page (the API's own cursor).
  const invoicesCursor = pageCursor(query.invoices);

  if (!isTenantId(tenantId)) {
    return (
      <div className="flex flex-col gap-6">
        <BackLink />
        <PlatformPageHeader title="Tenant" />
        <RegistryStatePanel state="not-found" />
      </div>
    );
  }

  const [detail, locations, lifecycle, subscription, plans, billing, invoices, complimentary, session, adjustments] = await Promise.all([
    getPlatformTenant(tenantId),
    listPlatformTenantLocations(tenantId, locationPage),
    getPlatformTenantLifecycle(tenantId),
    getPlatformTenantSubscription(tenantId),
    listPlatformPlans(),
    getPlatformTenantBilling(tenantId),
    getPlatformTenantInvoices(tenantId, invoicesCursor),
    getPlatformTenantComplimentary(tenantId),
    getPlatformSession(),
    listPlatformTenantAdjustments(tenantId),
  ]);
  const permissions = session.state === "signed-in" ? session.permissions : [];
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

      {/* SC2a — the business's plan, add-ons and modules. */}
      <section aria-labelledby="tenant-subscription" className="flex flex-col gap-4">
        <h2 id="tenant-subscription" className="text-lg font-semibold text-text-primary">
          Subscription
        </h2>
        {subscription.state === "ok" && plans.state === "ok" ? (
          <SubscriptionPanel
            data={subscription.data}
            versions={assignableVersions(plans.data.plans)}
          />
        ) : (
          <RegistryStatePanel
            state={subscription.state !== "ok" ? subscription.state : plans.state === "ok" ? "unavailable" : plans.state}
            retryHref={`/platform/tenants/${tenant.id}`}
          />
        )}
      </section>

      {/* SC3b — billing (Stripe test mode): start billing; review only. */}
      <section aria-labelledby="tenant-billing" className="flex flex-col gap-4">
        <h2 id="tenant-billing" className="text-lg font-semibold text-text-primary">
          Billing
        </h2>
        {billing.state === "ok" && subscription.state === "ok" && plans.state === "ok" ? (
          (() => {
            const versionId = subscription.data.subscription?.version.id;
            const plan = plans.data.plans.find((candidate) =>
              candidate.versions.some((version) => version.id === versionId),
            );
            return (
              <>
                <BillingPanel
                  tenantId={tenant.id}
                  billing={billing.data.billing}
                  isFounding={plan?.key === "founding"}
                  prices={(plan?.prices ?? []).filter((price) => price.status === "ACTIVE")}
                />
                {billing.data.billing && billing.data.billing.state !== "COMPLIMENTARY" ? (
                  <BillingOperationsPanel tenantId={tenant.id} view={billing.data} />
                ) : null}
                {billing.data.paymentSetup ? (
                  <PaymentSetupPanel
                    tenantId={tenant.id}
                    setup={billing.data.paymentSetup}
                    canExtend={holds(permissions, "billing.accounts.manage")}
                  />
                ) : null}
                {complimentary.state === "ok" ? (
                  <ComplimentaryPanel
                    tenantId={tenant.id}
                    view={complimentary.data}
                    versions={assignableVersions(plans.data.plans)}
                    canManage={holds(permissions, "billing.complimentary.manage")}
                  />
                ) : (
                  <RegistryStatePanel state={complimentary.state} retryHref={`/platform/tenants/${tenant.id}`} />
                )}
                {billing.data.billing && billing.data.billing.state !== "COMPLIMENTARY" ? (
                  <section aria-labelledby="tenant-invoices" className="flex flex-col gap-3">
                    <h3 id="tenant-invoices" className="text-base font-semibold text-text-primary">
                      Invoices
                    </h3>
                    <p className="text-xs text-text-secondary">
                      CENTERIVO subscription invoices as the payment provider reported them (read-only). Documents
                      are opened by the business, or in the provider dashboard.
                    </p>
                    {invoices.state === "ok" ? (
                      invoices.data.invoices.length === 0 ? (
                        <p className="text-sm text-text-secondary">No invoices recorded yet.</p>
                      ) : (
                        <>
                          <InvoiceList
                            invoices={invoices.data.invoices}
                            actions={
                              holds(permissions, "billing.adjustments.request")
                                ? (invoice, label) =>
                                    invoice.status === "paid" && invoice.amountPaidMinorUnits > 0 ? (
                                      <Link
                                        href={`/platform/tenants/${tenant.id}/invoices/${invoice.id}/adjust`}
                                        aria-label={`Refund or credit ${label}`}
                                        className="inline-flex min-h-11 items-center self-start font-medium underline underline-offset-2"
                                      >
                                        Refund or credit…
                                      </Link>
                                    ) : null
                                : undefined
                            }
                          />
                          <nav aria-label="Invoice pages" className="flex flex-wrap gap-4 text-sm">
                            {invoicesCursor ? (
                              <Link
                                href={`/platform/tenants/${tenant.id}`}
                                className="inline-flex min-h-11 items-center font-medium underline underline-offset-2"
                              >
                                Newest invoices
                              </Link>
                            ) : null}
                            {invoices.data.nextCursor ? (
                              <Link
                                href={`/platform/tenants/${tenant.id}?invoices=${invoices.data.nextCursor}`}
                                className="inline-flex min-h-11 items-center font-medium underline underline-offset-2"
                              >
                                Older invoices
                              </Link>
                            ) : null}
                          </nav>
                        </>
                      )
                    ) : (
                      <RegistryStatePanel state={invoices.state} retryHref={`/platform/tenants/${tenant.id}`} />
                    )}
                  </section>
                ) : null}
                {adjustments.state === "ok" && adjustments.data.adjustments.length > 0 ? (
                  <section aria-labelledby="tenant-adjustments" className="flex flex-col gap-3">
                    <h3 id="tenant-adjustments" className="text-base font-semibold text-text-primary">
                      Refunds and credits
                    </h3>
                    <ul className="flex flex-col gap-3">
                      {adjustments.data.adjustments.map((view) => (
                        <li key={view.id} className="rounded-lg border border-border-default px-3 py-3">
                          <AdjustmentSummary view={view} linkTitle />
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </>
            );
          })()
        ) : (
          <RegistryStatePanel
            state={billing.state !== "ok" ? billing.state : "unavailable"}
            retryHref={`/platform/tenants/${tenant.id}`}
          />
        )}
      </section>

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
