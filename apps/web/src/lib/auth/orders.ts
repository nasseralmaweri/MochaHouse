import "server-only";
import type {
  CustomerOrderDetail,
  CustomerOrderSummary,
} from "@mocha-house/contracts";

// The "server-only" import above makes it a build error for any Client
// Component to import this module — both calls take the customer session
// token as a plain parameter (see lib/auth/session.ts's
// getCustomerSessionToken) rather than reading the cookie themselves, but
// they still attach that raw bearer token to an outgoing request and read
// the server-only API_URL, neither of which may ever end up in a browser
// bundle.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;

  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }

  return apiUrl;
}

export type CustomerOrdersResult =
  | { outcome: "success"; orders: CustomerOrderSummary[] }
  | { outcome: "unauthorized" }
  | { outcome: "error" };

export async function getCustomerOrders(
  token: string,
): Promise<CustomerOrdersResult> {
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/customers/me/orders`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    return { outcome: "error" };
  }

  if (response.status === 401) {
    return { outcome: "unauthorized" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return { outcome: "success", orders: (await response.json()) as CustomerOrderSummary[] };
}

export type CustomerOrderDetailResult =
  | { outcome: "success"; order: CustomerOrderDetail }
  | { outcome: "unauthorized" }
  | { outcome: "not-found" }
  | { outcome: "error" };

export async function getCustomerOrderDetail(
  token: string,
  orderId: string,
): Promise<CustomerOrderDetailResult> {
  let response: Response;
  try {
    response = await fetch(
      `${getApiUrl()}/customers/me/orders/${orderId}`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
    );
  } catch {
    return { outcome: "error" };
  }

  if (response.status === 401) {
    return { outcome: "unauthorized" };
  }
  // 404 also covers "exists, but belongs to another customer" — the API
  // deliberately never distinguishes the two (see CustomerOrdersService).
  if (response.status === 404) {
    return { outcome: "not-found" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return { outcome: "success", order: (await response.json()) as CustomerOrderDetail };
}
