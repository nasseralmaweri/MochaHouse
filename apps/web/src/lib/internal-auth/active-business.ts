import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import type {
  InternalBusinessesResponse,
  InternalBusinessSummary,
} from "@mocha-house/contracts";
import { resolveActiveBusiness } from "@/lib/admin/business-context";

// Non-security UI preference: which authorized business the Admin shell
// last selected. INTENT only — it is validated against the API's own list of
// the identity's enterable businesses before it is ever used, and the API
// re-validates membership on every request (Milestone S0F).
export const ADMIN_BUSINESS_COOKIE = "mh_admin_business";

// The S0F active-business request header.
export const ACTIVE_TENANT_HEADER = "X-Tenant-Id";

export type AccessibleBusinessesResult =
  | { outcome: "ok"; businesses: InternalBusinessSummary[] }
  | { outcome: "forbidden" }
  | { outcome: "unauthenticated" }
  | { outcome: "error" };

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

// GET /internal/businesses — needs only a valid internal token, no active
// business. React-cached per render so the layout and pages share one call.
export const getAccessibleBusinesses = cache(
  async (token: string): Promise<AccessibleBusinessesResult> => {
    let response: Response;
    try {
      response = await fetch(`${getApiUrl()}/internal/businesses`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
    } catch {
      return { outcome: "error" };
    }
    if (response.status === 401) return { outcome: "unauthenticated" };
    if (response.status === 403) return { outcome: "forbidden" };
    if (!response.ok) return { outcome: "error" };
    const body = (await response.json()) as InternalBusinessesResponse;
    return { outcome: "ok", businesses: body.businesses };
  },
);

// The business id to send as X-Tenant-Id: the validated cookie choice, or
// the identity's only business. null when a choice is still required (the
// API would answer 409) or nothing is enterable.
export const getActiveBusinessId = cache(
  async (token: string): Promise<string | null> => {
    const result = await getAccessibleBusinesses(token);
    if (result.outcome !== "ok") return null;
    const cookieStore = await cookies();
    const resolution = resolveActiveBusiness(
      result.businesses,
      cookieStore.get(ADMIN_BUSINESS_COOKIE)?.value ?? null,
    );
    return resolution.kind === "active" ? resolution.business.id : null;
  },
);

// Headers for every server-side Admin API call: the bearer token plus the
// resolved active business.
export async function internalAuthHeaders(
  token: string,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const businessId = await getActiveBusinessId(token);
  if (businessId) {
    headers[ACTIVE_TENANT_HEADER] = businessId;
  }
  return headers;
}
