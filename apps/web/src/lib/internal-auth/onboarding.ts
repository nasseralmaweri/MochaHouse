import "server-only";

import { cookies } from "next/headers";
import type { OwnerOnboardingStatus } from "@mocha-house/contracts";
import { cookieName } from "@/lib/security/cookies";

// SC4b — the RESTRICTED onboarding session (owner decision B2): a verified,
// self-registered owner who has no business yet. Its own cookie, never the
// internal session cookie, so no /admin page ever reads it; the API refuses
// it everywhere except /internal/onboarding (no staff row, no business).
export const ONBOARDING_SESSION_COOKIE_BASE = "mh_onboarding_session";
export const ONBOARDING_SESSION_COOKIE = cookieName(ONBOARDING_SESSION_COOKIE_BASE);

export async function getOnboardingToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(ONBOARDING_SESSION_COOKIE)?.value ?? null;
}

export type OnboardingStatusResult =
  | { outcome: "ok"; status: OwnerOnboardingStatus }
  | { outcome: "unauthenticated" }
  | { outcome: "not-eligible" }
  | { outcome: "error" };

export async function fetchOnboardingStatus(token: string): Promise<OnboardingStatusResult> {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) return { outcome: "error" };
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/internal/onboarding`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    return { outcome: "error" };
  }
  if (response.status === 401) return { outcome: "unauthenticated" };
  // 403: not a verified self-registered owner; 404: registration is off.
  if (response.status === 403 || response.status === 404) {
    return { outcome: "not-eligible" };
  }
  if (!response.ok) return { outcome: "error" };
  return { outcome: "ok", status: (await response.json()) as OwnerOnboardingStatus };
}
