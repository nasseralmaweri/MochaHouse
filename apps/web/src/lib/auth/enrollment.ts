import "server-only";
import { storefrontApiFetch } from "@/lib/storefront-context";
import type { CustomerEnrollmentResponse } from "@mocha-house/contracts";

// SC4f-2 — the customer's explicit choice to join the current restaurant
// with their CENTERIVO login (POST /customers/me/enrollment). The API takes
// the restaurant from the request's resolved storefront, never from here.
// Server-only: attaches the raw bearer token. Mirrors lib/auth/profile.ts.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;

  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }

  return apiUrl;
}

export type EnrollResult =
  | { outcome: "success"; response: CustomerEnrollmentResponse }
  | { outcome: "unauthorized" }
  | { outcome: "refused"; message: string }
  | { outcome: "rate-limited" }
  | { outcome: "error" };

export async function enrollCustomer(token: string): Promise<EnrollResult> {
  let response: Response;
  try {
    response = await storefrontApiFetch(
      `${getApiUrl()}/customers/me/enrollment`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
        cache: "no-store",
      },
    );
  } catch {
    return { outcome: "error" };
  }

  if (response.status === 401) return { outcome: "unauthorized" };
  if (response.status === 429) return { outcome: "rate-limited" };
  if (response.status === 403) {
    const body = (await response.json().catch(() => null)) as {
      message?: unknown;
    } | null;
    return {
      outcome: "refused",
      message:
        typeof body?.message === "string"
          ? body.message
          : "You can't join this restaurant with this account right now.",
    };
  }
  if (!response.ok) return { outcome: "error" };
  return {
    outcome: "success",
    response: (await response.json()) as CustomerEnrollmentResponse,
  };
}

// Where to go after joining: only this app's own account or ordering pages,
// never an absolute, protocol-relative or other-site address.
export function safeReturnPath(raw: unknown): string {
  if (typeof raw !== "string") return "/account";
  if (!/^\/(account|order)(\/[A-Za-z0-9\-/]*)?$/.test(raw)) return "/account";
  return raw;
}
