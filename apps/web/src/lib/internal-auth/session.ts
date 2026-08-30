import "server-only";
import { cookies } from "next/headers";
import type { InternalUserProfile } from "@mocha-house/contracts";

// The "server-only" import above makes it a build error for any Client
// Component to import this module (directly or transitively). This file
// handles the raw internal session token, which must never reach browser
// code even accidentally.
//
// A SEPARATE boundary from lib/auth/session.ts (customer sessions): a
// different cookie name, a different backend endpoint, a different profile
// type. Neither is interchangeable with the other.
export const INTERNAL_SESSION_COOKIE = "mh_internal_session";

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;

  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }

  return apiUrl;
}

// Server-only: the raw internal bearer token, for the server-side proxy
// route (app/api/internal/admin/[...path]/route.ts) that attaches it to
// outgoing admin API calls. Never sent to the browser as script-readable
// state.
export async function getInternalSessionToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(INTERNAL_SESSION_COOKIE)?.value ?? null;
}

// Resolves the current internal session, if any, by calling the API's
// authoritative GET /internal/me with the session cookie's bearer token.
// Returns null both for "no session" and for "session present but no longer
// accepted" — an expired/invalid token, OR an internal user who is no
// longer ACTIVE (INVITED/SUSPENDED/DISABLED all yield 403 here), OR the API
// being unreachable. Callers (the /admin layout, the internal sign-in page)
// treat every null the same way: not an authenticated ACTIVE internal user.
export async function getInternalSession(): Promise<InternalUserProfile | null> {
  const token = await getInternalSessionToken();
  if (!token) {
    return null;
  }

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/internal/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  return response.json() as Promise<InternalUserProfile>;
}
