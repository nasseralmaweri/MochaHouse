"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type {
  CustomerRegisterRequest,
  CustomerRegisterResponse,
  CustomerResendVerificationRequest,
  CustomerResendVerificationResponse,
  CustomerSignInRequest,
  CustomerSignInResponse,
  CustomerVerifyRequest,
  CustomerVerifyResponse,
} from "@mocha-house/contracts";
import { CUSTOMER_SESSION_COOKIE } from "./session";

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;

  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }

  return apiUrl;
}

export interface SignInFormState {
  error: string | null;
}

// Server Action backing /account/sign-in's form. Credentials are posted
// straight from this server-side action to the API — the browser never
// sees the resulting token except as an httpOnly cookie it can't read.
export async function signInAction(
  _previousState: SignInFormState,
  formData: FormData,
): Promise<SignInFormState> {
  const identifier = String(formData.get("identifier") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!identifier || !password) {
    return { error: "Email and password are required." };
  }

  const request: CustomerSignInRequest = { identifier, password };

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/auth/sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return {
      error: "Could not reach the server. Check your connection and try again.",
    };
  }

  if (!response.ok) {
    return { error: "Invalid email or password." };
  }

  const result = (await response.json()) as CustomerSignInResponse;

  const cookieStore = await cookies();
  cookieStore.set(CUSTOMER_SESSION_COOKIE, result.idToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: result.expiresInSeconds,
  });

  redirect("/account");
}

// Shared by the actions below: our OWN API's error messages (register,
// verify, resend) are already written to be safe/customer-facing (never a
// raw Cognito message — see AuthController) — this just recovers that
// message text, falling back to a generic one if the response somehow has
// no JSON body at all.
async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
}

export interface RegisterFormState {
  error: string | null;
}

// Server Action backing /account/register's form. Like signInAction, the
// password is posted straight from here to the API and never returns to
// the client in any form — on success this redirects (carrying only the
// email, never the password) to /account/verify.
export async function registerAction(
  _previousState: RegisterFormState,
  formData: FormData,
): Promise<RegisterFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const displayName = String(formData.get("displayName") ?? "").trim();

  if (!email || !password || !displayName) {
    return { error: "Name, email, and password are required." };
  }

  const request: CustomerRegisterRequest = { email, password, displayName };

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return {
      error: "Could not reach the server. Check your connection and try again.",
    };
  }

  if (!response.ok) {
    return { error: await readErrorMessage(response, "Could not create your account. Please try again.") };
  }

  const result = (await response.json()) as CustomerRegisterResponse;
  redirect(`/account/verify?email=${encodeURIComponent(result.email)}`);
}

export interface VerifyFormState {
  error: string | null;
}

// Server Action backing /account/verify's form. Deliberately does not sign
// the customer in on success — it redirects to /account/sign-in, keeping
// Register -> Verify -> Sign In as three separate, explicit steps.
export async function verifyAction(
  _previousState: VerifyFormState,
  formData: FormData,
): Promise<VerifyFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();

  if (!email || !code) {
    return { error: "Email and verification code are required." };
  }

  const request: CustomerVerifyRequest = { email, code };

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return {
      error: "Could not reach the server. Check your connection and try again.",
    };
  }

  if (!response.ok) {
    return { error: await readErrorMessage(response, "We couldn't verify your account. Please try again.") };
  }

  const result = (await response.json()) as CustomerVerifyResponse;
  redirect(`/account/sign-in?verified=${encodeURIComponent(result.email)}`);
}

export interface ResendVerificationFormState {
  message: string | null;
  error: string | null;
}

// Stays on /account/verify either way (never redirects) — the customer
// still needs to enter the newly-sent code on the same page.
export async function resendVerificationAction(
  _previousState: ResendVerificationFormState,
  formData: FormData,
): Promise<ResendVerificationFormState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) {
    return { message: null, error: "Enter your email above, then resend." };
  }

  const request: CustomerResendVerificationRequest = { email };

  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/auth/verification/resend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return {
      message: null,
      error: "Could not reach the server. Check your connection and try again.",
    };
  }

  if (!response.ok) {
    return {
      message: null,
      error: await readErrorMessage(response, "Could not resend the verification code."),
    };
  }

  const result = (await response.json()) as CustomerResendVerificationResponse;
  return { message: `A new verification code has been sent to ${result.email}.`, error: null };
}

// Clears the Mocha House browser session (the httpOnly cookie) — after
// this, the browser sends no token, so getCustomerSession() and every
// protected page treat the customer as signed out immediately. This does
// not revoke the underlying Cognito ID token itself: it remains a valid,
// stateless JWT (in production, until its own ~1hr expiry) if it were
// somehow captured before sign-out. Server-side revocation (Cognito
// GlobalSignOut) is deliberately deferred to a later Milestone 4 slice.
export async function signOutAction(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(CUSTOMER_SESSION_COOKIE);
  redirect("/account/sign-in");
}
