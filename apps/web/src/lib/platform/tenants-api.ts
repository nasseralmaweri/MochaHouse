import "server-only";
import type {
  PlatformPlanListResponse,
  PlatformReconciliationCaseListResponse,
  PlatformTenantBillingResponse,
  PlatformBillingOverview,
  PlatformCaseDetailResponse,
  PlatformComplimentaryListResponse,
  PlatformComplimentaryView,
  PlatformPaymentSetupListResponse,
  PlatformOnboardingBusinessListResponse,
  PlatformRegistrationControlView,
  PlatformRegistrationListResponse,
  PlatformRevenueReport,
  PlatformStorefrontView,
  PlatformAdjustableInvoice,
  PlatformAdjustmentListResponse,
  PlatformAdjustmentView,
  PlatformOperatorDirectoryResponse,
  BillingInvoiceListResponse,
  PlatformTenantSubscriptionResponse,
  PlatformTenantDetailResponse,
  PlatformTenantLifecycleResponse,
  PlatformTenantListResponse,
  PlatformTenantLocationListResponse,
} from "@mocha-house/contracts";
import {
  getPlatformSessionToken,
  platformApiUrl,
} from "@/lib/platform-auth/session";
import {
  LOCATION_PAGE_SIZE,
  registryStateFromStatus,
  tenantListQuery,
  type RegistryState,
  type TenantListFilters,
} from "./tenant-registry";

// SC1c — the tenant registry, read on the server with the operator's
// HttpOnly session (the token never reaches browser code). The API's
// platform boundary re-verifies it and re-reads the operator every time.

export type RegistryResult<T> =
  | { state: "ok"; data: T }
  | { state: Exclude<RegistryState, "ok"> };

async function readRegistry<T>(path: string): Promise<RegistryResult<T>> {
  const token = await getPlatformSessionToken();
  if (!token) return { state: "session-ended" };
  let response: Response;
  try {
    response = await fetch(`${platformApiUrl()}/platform${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    return { state: "unavailable" };
  }
  const state = registryStateFromStatus(response.status);
  if (state !== "ok") return { state };
  try {
    return { state: "ok", data: (await response.json()) as T };
  } catch {
    return { state: "unavailable" };
  }
}

export function listPlatformTenants(
  filters: TenantListFilters,
): Promise<RegistryResult<PlatformTenantListResponse>> {
  return readRegistry(`/tenants?${tenantListQuery(filters)}`);
}

// Registry totals only (one row requested): for the Overview.
export function getPlatformRegistryTotals(): Promise<
  RegistryResult<PlatformTenantListResponse>
> {
  return readRegistry("/tenants?pageSize=1");
}

export function getPlatformTenant(
  tenantId: string,
): Promise<RegistryResult<PlatformTenantDetailResponse>> {
  return readRegistry(`/tenants/${encodeURIComponent(tenantId)}`);
}

// SC1e — status, first owner and suspension impact counts.
export function getPlatformTenantLifecycle(
  tenantId: string,
): Promise<RegistryResult<PlatformTenantLifecycleResponse>> {
  return readRegistry(`/tenants/${encodeURIComponent(tenantId)}/lifecycle`);
}

// SC2a — plans (with versions and subscriber counts), and one business's
// subscription (plan, add-ons, effective modules, history).
export function listPlatformPlans(): Promise<RegistryResult<PlatformPlanListResponse>> {
  return readRegistry("/plans");
}

export function getPlatformTenantSubscription(
  tenantId: string,
): Promise<RegistryResult<PlatformTenantSubscriptionResponse>> {
  return readRegistry(`/tenants/${encodeURIComponent(tenantId)}/subscription`);
}

// SC3b — one business's billing, and the billing cases to review.
export function getPlatformTenantBilling(
  tenantId: string,
): Promise<RegistryResult<PlatformTenantBillingResponse>> {
  return readRegistry(`/tenants/${encodeURIComponent(tenantId)}/billing`);
}

// SC3e-1 — a business's invoice history (read-only), a page at a time.
export function getPlatformTenantInvoices(
  tenantId: string,
  cursor: string | null,
): Promise<RegistryResult<BillingInvoiceListResponse>> {
  return readRegistry(
    `/tenants/${encodeURIComponent(tenantId)}/billing/invoices${
      cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
    }`,
  );
}

// SC3e-2 — complimentary arrangements and a review case's detail.
export function getPlatformTenantComplimentary(
  tenantId: string,
): Promise<RegistryResult<PlatformComplimentaryView>> {
  return readRegistry(`/tenants/${encodeURIComponent(tenantId)}/billing/complimentary`);
}

export function listPlatformComplimentary(): Promise<
  RegistryResult<PlatformComplimentaryListResponse>
> {
  return readRegistry("/billing/complimentary");
}

export function getPlatformCase(
  caseId: string,
): Promise<RegistryResult<PlatformCaseDetailResponse>> {
  return readRegistry(`/billing/reconciliation-cases/${encodeURIComponent(caseId)}`);
}

// SC3e-3 — refunds and credits, and operator permissions.
export function listPlatformAdjustments(
  status: "OPEN" | "ALL",
): Promise<RegistryResult<PlatformAdjustmentListResponse>> {
  return readRegistry(`/billing/adjustments?status=${status}`);
}

export function listPlatformTenantAdjustments(
  tenantId: string,
): Promise<RegistryResult<PlatformAdjustmentListResponse>> {
  return readRegistry(`/tenants/${encodeURIComponent(tenantId)}/billing/adjustments`);
}

export function getPlatformAdjustment(
  adjustmentId: string,
): Promise<RegistryResult<PlatformAdjustmentView>> {
  return readRegistry(`/billing/adjustments/${encodeURIComponent(adjustmentId)}`);
}

// Read live from the payment provider (billing.adjustments.request).
export function getPlatformAdjustableInvoice(
  tenantId: string,
  invoiceId: string,
): Promise<RegistryResult<PlatformAdjustableInvoice>> {
  return readRegistry(
    `/tenants/${encodeURIComponent(tenantId)}/billing/invoices/${encodeURIComponent(invoiceId)}/adjustable`,
  );
}

export function listPlatformOperators(): Promise<RegistryResult<PlatformOperatorDirectoryResponse>> {
  return readRegistry("/operators");
}

// SC3f — the SaaS revenue report (billing.reports.view).
export function getPlatformRevenueReport(period: {
  from?: string;
  to?: string;
}): Promise<RegistryResult<PlatformRevenueReport>> {
  const query = new URLSearchParams(period as Record<string, string>).toString();
  return readRegistry(`/billing/reports/revenue${query ? `?${query}` : ""}`);
}

// SC3e-4 — businesses that still need payment setup.
export function listPlatformPaymentSetup(): Promise<RegistryResult<PlatformPaymentSetupListResponse>> {
  return readRegistry("/billing/payment-setup");
}

// SC3c-3 — the console's billing attention counts.
export function getPlatformBillingOverview(): Promise<
  RegistryResult<PlatformBillingOverview>
> {
  return readRegistry("/billing/overview");
}

export function listPlatformReconciliationCases(
  status: "OPEN" | "RESOLVED",
): Promise<RegistryResult<PlatformReconciliationCaseListResponse>> {
  return readRegistry(`/billing/reconciliation-cases?status=${status}`);
}

export function listPlatformTenantLocations(
  tenantId: string,
  page: number,
): Promise<RegistryResult<PlatformTenantLocationListResponse>> {
  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(LOCATION_PAGE_SIZE),
  });
  return readRegistry(
    `/tenants/${encodeURIComponent(tenantId)}/locations?${query.toString()}`,
  );
}

// SC4e — onboarding oversight (onboarding.view). The query strings come from
// lib/platform/onboarding.ts and are re-validated by the API.
// SC4f-3a — a business's storefront addresses, eligibility and history
// (storefront.manage).
export function getTenantStorefront(
  tenantId: string,
): Promise<RegistryResult<PlatformStorefrontView>> {
  return readRegistry(`/tenants/${encodeURIComponent(tenantId)}/storefront`);
}

export function getRegistrationControl(): Promise<RegistryResult<PlatformRegistrationControlView>> {
  return readRegistry("/onboarding/registration-control");
}

export function listRegistrations(query: string): Promise<RegistryResult<PlatformRegistrationListResponse>> {
  return readRegistry(`/onboarding/registrations?${query}`);
}

export function listOnboardingBusinesses(query: string): Promise<RegistryResult<PlatformOnboardingBusinessListResponse>> {
  return readRegistry(`/onboarding/businesses?${query}`);
}
