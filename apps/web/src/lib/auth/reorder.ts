import "server-only";
import type { ReorderPreparation } from "@mocha-house/contracts";

// "server-only": attaches the raw bearer token and reads the server-only
// API_URL. Mirrors lib/auth/orders.ts.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type PrepareReorderResult =
  | { outcome: "success"; preparation: ReorderPreparation }
  | { outcome: "unauthorized" }
  | { outcome: "not-found" }
  | { outcome: "error" };

// Calls the PREPARE endpoint (POST, but it creates nothing — see
// CustomerReorderService). A non-owned / nonexistent order is a 404, the
// same as the order-detail endpoint.
export async function prepareReorder(
  token: string,
  orderId: string,
): Promise<PrepareReorderResult> {
  let response: Response;
  try {
    response = await fetch(
      `${getApiUrl()}/customers/me/orders/${encodeURIComponent(orderId)}/reorder`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      },
    );
  } catch {
    return { outcome: "error" };
  }

  if (response.status === 401) {
    return { outcome: "unauthorized" };
  }
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return {
    outcome: "success",
    preparation: (await response.json()) as ReorderPreparation,
  };
}
