import "server-only";
import type { CustomerLoyaltySummary } from "@mocha-house/contracts";

// Server-only read of the authenticated customer's Mocha Bean balance
// (Milestone 7A). Takes the session token as a plain parameter (like
// lib/auth/orders.ts) rather than reading the cookie itself, but still
// attaches that raw bearer token to an outgoing request and reads the
// server-only API_URL — neither may end up in a browser bundle.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type CustomerLoyaltyResult =
  | { outcome: "success"; summary: CustomerLoyaltySummary }
  | { outcome: "unauthorized" }
  | { outcome: "error" };

export async function getCustomerLoyalty(
  token: string,
): Promise<CustomerLoyaltyResult> {
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/customers/me/loyalty`, {
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

  return {
    outcome: "success",
    summary: (await response.json()) as CustomerLoyaltySummary,
  };
}
