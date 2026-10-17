"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type {
  InternalBusinessesResponse,
  OwnerBusinessCreateRequest,
} from "@mocha-house/contracts";
import { serverActionClientIpHeaders } from "@/lib/client-ip-forwarding";
import {
  clearLegacySessionCookie,
  clearSessionCookie,
  sessionCookieOptions,
} from "@/lib/security/cookies";
import {
  ACTIVE_TENANT_HEADER,
  ADMIN_BUSINESS_COOKIE,
  ADMIN_BUSINESS_COOKIE_BASE,
} from "./active-business";
import { INTERNAL_SESSION_COOKIE, INTERNAL_SESSION_COOKIE_BASE } from "./session";
import {
  ONBOARDING_SESSION_COOKIE_BASE,
  getOnboardingToken,
} from "./onboarding";
import {
  createBusinessError,
  parsePriceChoice,
  tokenLifetimeSeconds,
  type CreateBusinessState,
} from "./onboarding-state";
import { readApiMessage } from "./registration-state";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error("API_URL environment variable is not set. See apps/web/.env.example.");
  }
  return apiUrl;
}

// SC4b — create the owner's business with the plan and price they chose.
// The owner is the onboarding session's own login; the API decides
// everything else and refuses (409) a plan or price that differs from what
// was shown.
export async function createBusinessAction(
  _previous: CreateBusinessState,
  formData: FormData,
): Promise<CreateBusinessState> {
  const token = await getOnboardingToken();
  if (!token) redirect("/internal/sign-in");

  const choice = parsePriceChoice(String(formData.get("priceChoice") ?? ""));
  if (!choice) return { error: "Choose a plan and a price." };
  const request: OwnerBusinessCreateRequest = {
    businessName: String(formData.get("businessName") ?? ""),
    ...choice,
  };

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/internal/onboarding/business`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(await serverActionClientIpHeaders()),
      },
      body: JSON.stringify(request),
      cache: "no-store",
    });
  } catch {
    return { error: createBusinessError(null) };
  }
  if (!response.ok) {
    return {
      error: createBusinessError({
        status: response.status,
        message: readApiMessage(await response.json().catch(() => null)),
      }),
    };
  }
  // The business exists now. If the hand-off below cannot complete, the
  // page re-reads its state and offers "Open your business" — never the
  // create form again.
  await enterBusiness(token);
  redirect("/internal/onboarding");
}

// The verified transition from the onboarding session to the business: the
// API must list the business for this login and admit it there (GET
// /internal/me as an ACTIVE staff member) before the normal session cookie
// is set. The onboarding cookie is then removed.
export async function enterBusinessAction(): Promise<CreateBusinessState> {
  const token = await getOnboardingToken();
  if (!token) redirect("/internal/sign-in");
  return enterBusiness(token);
}

async function enterBusiness(token: string): Promise<CreateBusinessState> {
  let businessId: string | null = null;
  try {
    const listed = await fetch(`${getApiUrl()}/internal/businesses`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (listed.ok) {
      const { businesses } = (await listed.json()) as InternalBusinessesResponse;
      if (businesses.length === 1) {
        const me = await fetch(`${getApiUrl()}/internal/me`, {
          headers: {
            Authorization: `Bearer ${token}`,
            [ACTIVE_TENANT_HEADER]: businesses[0].id,
          },
          cache: "no-store",
        });
        if (me.ok) businessId = businesses[0].id;
      }
    }
  } catch {
    return { error: createBusinessError(null) };
  }
  const lifetime = tokenLifetimeSeconds(token);
  if (businessId === null || lifetime === 0) {
    return { error: "Your business is ready. Sign in again to open it." };
  }

  const cookieStore = await cookies();
  clearLegacySessionCookie(cookieStore, INTERNAL_SESSION_COOKIE_BASE);
  cookieStore.set(INTERNAL_SESSION_COOKIE, token, sessionCookieOptions(lifetime));
  clearLegacySessionCookie(cookieStore, ADMIN_BUSINESS_COOKIE_BASE);
  cookieStore.set(ADMIN_BUSINESS_COOKIE, businessId, sessionCookieOptions(ONE_YEAR_SECONDS));
  clearSessionCookie(cookieStore, ONBOARDING_SESSION_COOKIE_BASE);
  redirect("/admin");
}

export async function onboardingSignOutAction(): Promise<void> {
  const cookieStore = await cookies();
  clearSessionCookie(cookieStore, ONBOARDING_SESSION_COOKIE_BASE);
  redirect("/internal/sign-in");
}
