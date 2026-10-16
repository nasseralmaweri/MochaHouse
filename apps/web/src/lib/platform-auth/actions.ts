"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { serverActionClientIpHeaders } from "@/lib/client-ip-forwarding";
import {
  PLATFORM_CHALLENGE_COOKIE_BASE,
  PLATFORM_CHALLENGE_MAX_AGE_SECONDS,
  PLATFORM_SESSION_COOKIE_BASE,
  clearPlatformCookie,
  platformCookieName,
  platformCookieOptions,
  platformSessionMaxAge,
} from "./cookies";
import {
  getPlatformChallenge,
  getPlatformSessionToken,
  platformApiUrl,
} from "./session";
import {
  PLATFORM_MESSAGES,
  interpretCode,
  interpretMfaSetup,
  interpretSignIn,
  isSixDigitCode,
  normaliseCode,
  type CodeStep,
  type PlatformSignInNotice,
} from "./sign-in-flow";

// SC1b — the CENTERIVO platform-operator sign-in, run entirely server-side.
// Credentials and codes are posted from the server to the API's platform
// sign-in boundary; the browser only ever receives HttpOnly cookies (an
// opaque challenge handle, then the session) and never a token, a Cognito
// session or a provider error. The session cookie is set ONLY after the API
// confirmed both factors for an ACTIVE platform operator.

export interface PlatformFormState {
  error: string | null;
  // Echoed back after a failed password step so the operator does not
  // retype it (never the password).
  email?: string;
}

async function postJson(
  path: string,
  body: object,
  init: { forwardClientIp?: boolean } = {},
): Promise<{ status: number; body: unknown } | null> {
  try {
    const response = await fetch(`${platformApiUrl()}/platform/auth/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(init.forwardClientIp ? await serverActionClientIpHeaders() : {}),
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  } catch {
    return null;
  }
}

function signInWithNotice(notice: PlatformSignInNotice): never {
  redirect(`/platform/sign-in?notice=${notice}`);
}

async function setChallenge(handle: string): Promise<void> {
  (await cookies()).set(
    platformCookieName(PLATFORM_CHALLENGE_COOKIE_BASE),
    handle,
    platformCookieOptions(PLATFORM_CHALLENGE_MAX_AGE_SECONDS),
  );
}

async function clearSignInState(): Promise<void> {
  clearPlatformCookie(await cookies(), PLATFORM_CHALLENGE_COOKIE_BASE);
}

// Step 1 — email and password.
export async function platformSignInAction(
  _previous: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    return { error: "Email and password are required.", email };
  }
  await clearSignInState();

  const result = await postJson(
    "sign-in",
    { email, password },
    { forwardClientIp: true },
  );
  if (!result) {
    return { error: PLATFORM_MESSAGES.unreachable, email };
  }
  const step = interpretSignIn(result.status, result.body);
  if (step.kind === "error") {
    return { error: step.message, email };
  }
  if (step.kind === "notice") {
    signInWithNotice(step.notice);
  }
  if (step.kind === "mfa") {
    await setChallenge(step.challenge);
    redirect("/platform/sign-in/verify");
  }

  // First sign-in: have the API issue the authenticator secret now. It stays
  // server-side with the attempt; only the next handle comes back, and the
  // setup page reads the secret from the API on the server.
  const setup = await postJson(
    "mfa-setup",
    { challenge: step.challenge },
    { forwardClientIp: true },
  );
  if (!setup) {
    return { error: PLATFORM_MESSAGES.unreachable, email };
  }
  const enrolment = interpretMfaSetup(setup.status, setup.body);
  if (enrolment.kind === "error") {
    return { error: enrolment.message, email };
  }
  if (enrolment.kind === "notice") {
    signInWithNotice(enrolment.notice);
  }
  await setChallenge(enrolment.challenge);
  redirect("/platform/sign-in/setup");
}

async function completeWithCode(
  path: "mfa" | "mfa-setup/verify",
  formData: FormData,
): Promise<PlatformFormState> {
  const code = normaliseCode(formData.get("code"));
  if (!isSixDigitCode(code)) {
    return { error: PLATFORM_MESSAGES.codeFormat };
  }
  const challenge = await getPlatformChallenge();
  if (!challenge) {
    signInWithNotice("restart");
  }
  const result = await postJson(
    path,
    { challenge, code },
    { forwardClientIp: true },
  );
  if (!result) {
    return { error: PLATFORM_MESSAGES.unreachable };
  }
  const step: CodeStep = interpretCode(result.status, result.body);
  if (step.kind === "error") {
    return { error: step.message };
  }
  await clearSignInState();
  if (step.kind === "notice") {
    signInWithNotice(step.notice);
  }
  const maxAge = platformSessionMaxAge(step.expiresInSeconds);
  if (maxAge <= 0) {
    signInWithNotice("restart");
  }
  (await cookies()).set(
    platformCookieName(PLATFORM_SESSION_COOKIE_BASE),
    step.idToken,
    platformCookieOptions(maxAge),
  );
  redirect("/platform");
}

// Step 2 — the TOTP code from the operator's authenticator.
export async function platformVerifyAction(
  _previous: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  return completeWithCode("mfa", formData);
}

// Step 2 on a first sign-in — the first code from the new authenticator.
export async function platformEnrolVerifyAction(
  _previous: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  return completeWithCode("mfa-setup/verify", formData);
}

// Abandon an in-progress sign-in.
export async function platformCancelSignInAction(): Promise<void> {
  await clearSignInState();
  redirect("/platform/sign-in");
}

// Sign out: the API records the end of the session (best effort — the
// cookie is removed whatever the API answers), then every platform cookie
// is cleared.
export async function platformSignOutAction(): Promise<void> {
  const token = await getPlatformSessionToken();
  if (token) {
    try {
      await fetch(`${platformApiUrl()}/platform/session/sign-out`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
    } catch {
      // The session ends locally regardless.
    }
  }
  const store = await cookies();
  clearPlatformCookie(store, PLATFORM_SESSION_COOKIE_BASE);
  clearPlatformCookie(store, PLATFORM_CHALLENGE_COOKIE_BASE);
  redirect("/platform/sign-in?notice=signed-out");
}
