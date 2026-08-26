import { cookies } from "next/headers";
import type { CustomerProfile } from "@mocha-house/contracts";

// Server-only: this module reads next/headers' cookies(), which throws if
// ever imported into client code, so there is no separate guard needed.
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

// Resolves the current customer session, if any, by calling the API's
// /customers/me with the session cookie's bearer token. Returns null both
// for "no session" and for "session present but no longer accepted"
// (expired/invalid token, or the API is unreachable) — callers (the
// /account pages) treat both the same way: no authenticated customer, so
// redirect to sign-in. This is the only place the customer session cookie
// is read; it is never sent to the browser as script-readable state.
export async function getCustomerSession(): Promise<CustomerProfile | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(CUSTOMER_SESSION_COOKIE)?.value;
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
