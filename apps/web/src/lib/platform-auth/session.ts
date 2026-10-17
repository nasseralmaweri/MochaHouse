import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import type {
  PlatformMeResponse,
  PlatformMfaSetupDisplayResponse,
} from "@mocha-house/contracts";
import {
  PLATFORM_CHALLENGE_COOKIE_BASE,
  PLATFORM_SESSION_COOKIE_BASE,
  platformCookieName,
} from "./cookies";
import {
  interpretMfaDisplay,
  sessionStateFromStatus,
  type PlatformSessionState,
} from "./sign-in-flow";

// SC1b — the CENTERIVO platform-operator session, server-side only (the
// "server-only" import makes any client import a build error). The raw token
// never reaches browser code; it is presented to the API's platform boundary
// (/api/v1/platform/*), which re-verifies it and re-reads the operator on
// every request. A separate boundary from lib/internal-auth (tenant staff)
// and lib/auth (customers).

export function platformApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export async function getPlatformSessionToken(): Promise<string | null> {
  return (
    (await cookies()).get(platformCookieName(PLATFORM_SESSION_COOKIE_BASE))
      ?.value ?? null
  );
}

export async function getPlatformChallenge(): Promise<string | null> {
  return (
    (await cookies()).get(platformCookieName(PLATFORM_CHALLENGE_COOKIE_BASE))
      ?.value ?? null
  );
}

// The authenticator secret for the setup page, read from the API on the
// server with the in-progress challenge handle. It is held server-side with
// the attempt (never in a cookie) and rendered for the operator to type or
// open — never placed in client-side state. null = no enrolment in progress.
export async function getPlatformEnrolment(
  challenge: string,
): Promise<PlatformMfaSetupDisplayResponse | null> {
  try {
    const response = await fetch(
      `${platformApiUrl()}/platform/auth/mfa-setup/display`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge }),
        cache: "no-store",
      },
    );
    return interpretMfaDisplay(
      response.status,
      await response.json().catch(() => null),
    );
  } catch {
    return null;
  }
}

export type PlatformSession =
  | {
      state: "signed-in";
      operator: PlatformMeResponse["operator"];
      // SC3e-2 — what the console offers (the API enforces every action).
      permissions: PlatformMeResponse["permissions"];
    }
  | { state: Exclude<PlatformSessionState, "signed-in"> };

// Resolved once per render (React cache) by asking the API's authoritative
// GET /platform/me. Fails closed: anything but a 200 is not a session.
export const getPlatformSession = cache(
  async (): Promise<PlatformSession> => {
    const token = await getPlatformSessionToken();
    if (!token) {
      return { state: "signed-out" };
    }
    let response: Response;
    try {
      response = await fetch(`${platformApiUrl()}/platform/me`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
    } catch {
      return { state: "unavailable" };
    }
    const state = sessionStateFromStatus(response.status);
    if (state !== "signed-in") {
      return { state };
    }
    try {
      const body = (await response.json()) as PlatformMeResponse;
      return {
        state: "signed-in",
        operator: body.operator,
        permissions: Array.isArray(body.permissions) ? body.permissions : [],
      };
    } catch {
      return { state: "unavailable" };
    }
  },
);
