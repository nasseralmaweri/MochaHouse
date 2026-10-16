import "server-only";
import type {
  PlatformTenantDetailResponse,
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
