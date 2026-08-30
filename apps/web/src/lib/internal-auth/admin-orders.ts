import "server-only";
import type { StoreOrderSummary } from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only reads of the authorized Admin Orders API for the dashboard
// snapshot. Attaches the internal bearer token server-side (never exposed
// to the browser). Distinguishes the failure modes the dashboard cares
// about rather than collapsing them.
function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type AdminOrdersSnapshotResult =
  | { outcome: "success"; orders: StoreOrderSummary[] }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "error" };

export async function getActiveStoreOrders(
  locationId: string,
): Promise<AdminOrdersSnapshotResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await fetch(
      `${getApiUrl()}/admin/orders?locationId=${encodeURIComponent(locationId)}`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
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
  if (!response.ok) {
    return { outcome: "error" };
  }

  return {
    outcome: "success",
    orders: (await response.json()) as StoreOrderSummary[],
  };
}
