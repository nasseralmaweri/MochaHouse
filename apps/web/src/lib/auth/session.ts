import "server-only";
import { cookies } from "next/headers";
import type { CustomerProfile } from "@mocha-house/contracts";

// The "server-only" import above makes it a build error for any Client
// Component to import this module (directly or transitively) — this file
// handles the raw session token (getCustomerSessionToken), which must
// never reach browser code even accidentally.
export const CUSTOMER_SESSION_COOKIE = "mh_customer_session";

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;

  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }

  return apiUrl;
}

// Server-only: the raw bearer token, for callers (order history) that need
// to attach it to a different API call themselves rather than resolving a
// full profile. Never sent to the browser as script-readable state.
export async function getCustomerSessionToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(CUSTOMER_SESSION_COOKIE)?.value ?? null;
}

// Resolves the current customer session, if any, by calling the API's
// /customers/me with the session cookie's bearer token. Returns null both
// for "no session" and for "session present but no longer accepted"
// (expired/invalid token, or the API is unreachable) — callers (the
// /account pages) treat both the same way: no authenticated customer, so
// redirect to sign-in.
export async function getCustomerSession(): Promise<CustomerProfile | null> {
  const token = await getCustomerSessionToken();
  if (!token) {
    return null;
  }

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/customers/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  return response.json() as Promise<CustomerProfile>;
}
