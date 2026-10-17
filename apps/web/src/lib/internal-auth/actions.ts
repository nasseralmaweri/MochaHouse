"use server";

import { cookies } from "next/headers";
import { clearLegacySessionCookie, clearSessionCookie, sessionCookieOptions } from "@/lib/security/cookies";
import { serverActionClientIpHeaders } from "@/lib/client-ip-forwarding";
import { TOO_MANY_ATTEMPTS_MESSAGE } from "@/lib/rate-limit-message";
import { redirect } from "next/navigation";
import type {
  InternalBusinessesResponse,
  InternalSignInRequest,
  InternalSignInResponse,
} from "@mocha-house/contracts";
import {
  ADMIN_LOCATION_COOKIE_BASE,
  INTERNAL_SESSION_COOKIE,
  INTERNAL_SESSION_COOKIE_BASE,
} from "./session";
import {
  ACTIVE_TENANT_HEADER,
  ADMIN_BUSINESS_COOKIE_BASE,
} from "./active-business";
import {
  ONBOARDING_SESSION_COOKIE,
  ONBOARDING_SESSION_COOKIE_BASE,
  fetchOnboardingStatus,
} from "./onboarding";

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;

  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }

  return apiUrl;
}

export interface InternalSignInFormState {
  error: string | null;
}

// Server Action backing /internal/sign-in's form. Credentials are posted
// server-side to the internal auth boundary; the browser never sees the
// resulting token except as an HttpOnly cookie it cannot read.
//
// Two steps, deliberately: (1) exchange credentials for an internal token,
// then (2) confirm — before establishing any session — that the token maps
// to an ACTIVE internal user by calling the authoritative GET /internal/me.
// A valid credential that belongs to an INVITED/SUSPENDED/DISABLED user
// (or no internal user at all) never gets a session cookie, and the person
// sees an immediate "not permitted" message rather than a confusing bounce
// off /admin later.
export async function internalSignInAction(
  _previousState: InternalSignInFormState,
  formData: FormData,
): Promise<InternalSignInFormState> {
  const identifier = String(formData.get("identifier") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!identifier || !password) {
    return { error: "Email and password are required." };
  }

  const request: InternalSignInRequest = { identifier, password };

  let signInResponse: Response;
  try {
    signInResponse = await fetch(`${getApiUrl()}/internal/auth/sign-in`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await serverActionClientIpHeaders()),
      },
      body: JSON.stringify(request),
    });
  } catch {
    return {
      error: "Could not reach the server. Check your connection and try again.",
    };
  }

  if (signInResponse.status === 429) {
    return { error: TOO_MANY_ATTEMPTS_MESSAGE };
  }

  if (!signInResponse.ok) {
    return { error: "Invalid email or password." };
  }

  const result = (await signInResponse.json()) as InternalSignInResponse;

  // Milestone S0F: which businesses may this person enter? An account that
  // can enter none gets no session. With exactly one, confirm it is usable
  // (an ACTIVE internal user) before establishing the session; with several
  // the person chooses after sign-in (/internal/choose-business).
  let businessesResponse: Response;
  try {
    businessesResponse = await fetch(`${getApiUrl()}/internal/businesses`, {
      headers: { Authorization: `Bearer ${result.idToken}` },
      cache: "no-store",
    });
  } catch {
    return {
      error: "Could not reach the server. Check your connection and try again.",
    };
  }

  let permitted = false;
  if (businessesResponse.ok) {
    const { businesses } =
      (await businessesResponse.json()) as InternalBusinessesResponse;
    if (businesses.length === 1) {
      try {
        const meResponse = await fetch(`${getApiUrl()}/internal/me`, {
          headers: {
            Authorization: `Bearer ${result.idToken}`,
            [ACTIVE_TENANT_HEADER]: businesses[0].id,
          },
          cache: "no-store",
        });
        permitted = meResponse.ok;
      } catch {
        return {
          error:
            "Could not reach the server. Check your connection and try again.",
        };
      }
    } else {
      permitted = businesses.length > 1;
    }
  }

  if (!permitted) {
    // SC4b — a verified, self-registered owner with no business yet gets
    // ONLY the restricted onboarding session (its own cookie; no /admin
    // page reads it, and the API admits it only to /internal/onboarding).
    if (businessesResponse.status === 403) {
      const onboarding = await fetchOnboardingStatus(result.idToken);
      if (onboarding.outcome === "ok") {
        const cookieStore = await cookies();
        clearLegacySessionCookie(cookieStore, ONBOARDING_SESSION_COOKIE_BASE);
        cookieStore.set(
          ONBOARDING_SESSION_COOKIE,
          result.idToken,
          sessionCookieOptions(result.expiresInSeconds),
        );
        redirect("/internal/onboarding");
      }
    }
    // Authenticated, but not an ACTIVE internal user — no session is
    // established.
    return {
      error: "This account is not permitted to access the internal area.",
    };
  }

  const cookieStore = await cookies();
  clearLegacySessionCookie(cookieStore, INTERNAL_SESSION_COOKIE_BASE);
  cookieStore.set(INTERNAL_SESSION_COOKIE, result.idToken, sessionCookieOptions(result.expiresInSeconds));
  clearSessionCookie(cookieStore, ONBOARDING_SESSION_COOKIE_BASE);

  redirect("/admin/orders");
}

// Clears the internal browser session (the HttpOnly cookie). After this the
// browser sends no internal token, so getInternalSession() and every /admin
// page treat the caller as signed out immediately. Like the customer
// sign-out, this does not revoke the underlying token server-side — that is
// deferred to a later Milestone 5 slice.
export async function internalSignOutAction(): Promise<void> {
  const cookieStore = await cookies();
  clearSessionCookie(cookieStore, INTERNAL_SESSION_COOKIE_BASE);
  clearSessionCookie(cookieStore, ADMIN_BUSINESS_COOKIE_BASE);
  clearSessionCookie(cookieStore, ADMIN_LOCATION_COOKIE_BASE);
  clearSessionCookie(cookieStore, ONBOARDING_SESSION_COOKIE_BASE);
  redirect("/internal/sign-in");
}
