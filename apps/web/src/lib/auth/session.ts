import "server-only";
import { storefrontApiFetch } from "@/lib/storefront-context";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  CUSTOMER_NOT_ENROLLED,
  type CustomerProfile,
} from "@mocha-house/contracts";
import { cookieName } from "@/lib/security/cookies";

// The "server-only" import above makes it a build error for any Client
// Component to import this module (directly or transitively) — this file
// handles the raw session token (getCustomerSessionToken), which must
// never reach browser code even accidentally.
export const CUSTOMER_SESSION_COOKIE_BASE = "mh_customer_session";
export const CUSTOMER_SESSION_COOKIE = cookieName(CUSTOMER_SESSION_COOKIE_BASE);

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

// SC4f-2 — where the signed-in visitor stands at THIS restaurant. One
// CENTERIVO login may have a profile at several restaurants; a session here
// is only useful once the login has joined this one.
//   signed-out    — no session, or one no longer accepted (expired/invalid
//                   token, or the API is unreachable);
//   not-enrolled  — a valid login that has not joined this restaurant;
//                   businessName is the RESOLVED restaurant's own name, from
//                   the API (never from the browser);
//   signed-in     — this restaurant's profile (whatever its status: a
//                   restricted or deactivated profile is still shown, so the
//                   customer is told why, and never treated as a guest).
export type CustomerAccountState =
  | { kind: "signed-out" }
  | { kind: "not-enrolled"; businessName: string }
  | { kind: "signed-in"; profile: CustomerProfile };

export async function getCustomerAccountState(): Promise<CustomerAccountState> {
  const token = await getCustomerSessionToken();
  if (!token) {
    return { kind: "signed-out" };
  }

  let response: Response;
  try {
    response = await storefrontApiFetch(`${getApiUrl()}/customers/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    return { kind: "signed-out" };
  }

  if (response.status === 403) {
    const body = (await response.json().catch(() => null)) as {
      code?: unknown;
      businessName?: unknown;
    } | null;
    if (
      body?.code === CUSTOMER_NOT_ENROLLED &&
      typeof body.businessName === "string"
    ) {
      return { kind: "not-enrolled", businessName: body.businessName };
    }
    return { kind: "signed-out" };
  }

  if (!response.ok) {
    return { kind: "signed-out" };
  }

  return {
    kind: "signed-in",
    profile: (await response.json()) as CustomerProfile,
  };
}

// The current restaurant's customer profile, or null for no accepted
// session — callers (the /account pages) then redirect to sign-in. A login
// that has not joined this restaurant yet is sent to /account/join instead,
// to choose explicitly whether to join.
export async function getCustomerSession(): Promise<CustomerProfile | null> {
  const state = await getCustomerAccountState();
  if (state.kind === "not-enrolled") {
    redirect("/account/join");
  }
  return state.kind === "signed-in" ? state.profile : null;
}
