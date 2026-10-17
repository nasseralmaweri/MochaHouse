import "server-only";
import type {
  AdminGettingStartedResponse,
  AdminLocationDetail,
  AdminLocationSummary,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";
import { internalAuthHeaders } from "./active-business";

// Server-only reads of the authorized Admin Locations API (Milestone 5D-1).
// Attaches the internal bearer token server-side (never exposed to the
// browser), and distinguishes the failure modes the Admin pages care about
// rather than collapsing them — mirrors lib/internal-auth/admin-orders.ts.
//
// The API (`/api/v1/admin/locations*`, InternalAuthGuard + PermissionGuard +
// `locations.view` + resource-level scope) is the sole authorization
// authority; these helpers only shape the outcome for the page.
function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type AdminLocationsListResult =
  | { outcome: "success"; locations: AdminLocationSummary[] }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "error" };

export async function getAdminLocations(): Promise<AdminLocationsListResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/admin/locations`, {
      headers: await internalAuthHeaders(token),
      cache: "no-store",
    });
  } catch {
    return { outcome: "error" };
  }

  if (response.status === 401) {
    return { outcome: "unauthenticated" };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return {
    outcome: "success",
    locations: (await response.json()) as AdminLocationSummary[],
  };
}

export type AdminLocationDetailResult =
  | { outcome: "success"; location: AdminLocationDetail }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "not-found" }
  | { outcome: "error" };

export async function getAdminLocation(
  locationId: string,
): Promise<AdminLocationDetailResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await fetch(
      `${getApiUrl()}/admin/locations/${encodeURIComponent(locationId)}`,
      {
        headers: await internalAuthHeaders(token),
        cache: "no-store",
      },
    );
  } catch {
    return { outcome: "error" };
  }

  if (response.status === 401) {
    return { outcome: "unauthenticated" };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return {
    outcome: "success",
    location: (await response.json()) as AdminLocationDetail,
  };
}

// SC4d — the business's getting-started checklist (corporate
// `locations.view`). Null when it can't be read for any reason: the
// checklist is guidance, so a page shows its other content without it.
export async function getAdminGettingStarted(): Promise<AdminGettingStartedResponse | null> {
  const token = await getInternalSessionToken();
  if (!token) {
    return null;
  }
  try {
    const response = await fetch(`${getApiUrl()}/admin/getting-started`, {
      headers: await internalAuthHeaders(token),
      cache: "no-store",
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as AdminGettingStartedResponse;
  } catch {
    return null;
  }
}
