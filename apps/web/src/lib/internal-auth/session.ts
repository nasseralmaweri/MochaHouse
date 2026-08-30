import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import type { InternalMeResponse } from "@mocha-house/contracts";

// The "server-only" import above makes it a build error for any Client
// Component to import this module (directly or transitively). This file
// handles the raw internal session token, which must never reach browser
// code even accidentally.
//
// A SEPARATE boundary from lib/auth/session.ts (customer sessions): a
// different cookie name, a different backend endpoint, a different response
// type. Neither is interchangeable with the other.
export const INTERNAL_SESSION_COOKIE = "mh_internal_session";

// Non-security UI preference: which authorized location (or "corporate")
// the Admin shell should default to between navigations. Never trusted for
// authorization — every Admin API call is still guarded server-side.
export const ADMIN_LOCATION_COOKIE = "mh_admin_location";

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
// route and server components that call the Admin API directly. Never sent
// to the browser as script-readable state.
export async function getInternalSessionToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(INTERNAL_SESSION_COOKIE)?.value ?? null;
}

// Resolves the current internal session, if any, by calling the API's
// authoritative GET /internal/me. Returns null both for "no session" and
// for "session present but no longer accepted" — an expired/invalid token,
// OR an internal user who is no longer ACTIVE (INVITED/SUSPENDED/DISABLED
// all yield 403 here), OR the API being unreachable. Callers (the /admin
// layout, the dashboard, the internal sign-in page) treat every null the
// same way: not an authenticated ACTIVE internal user.
//
// Wrapped in React `cache()` so the layout and the page that renders inside
// it share a single request to /internal/me per render.
export const getInternalSession = cache(
  async (): Promise<InternalMeResponse | null> => {
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

    return response.json() as Promise<InternalMeResponse>;
  },
);
