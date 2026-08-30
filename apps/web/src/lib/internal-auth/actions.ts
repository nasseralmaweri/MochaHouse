"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type {
  InternalSignInRequest,
  InternalSignInResponse,
} from "@mocha-house/contracts";
import { INTERNAL_SESSION_COOKIE } from "./session";

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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return {
      error: "Could not reach the server. Check your connection and try again.",
    };
  }

  if (!signInResponse.ok) {
    return { error: "Invalid email or password." };
  }

  const result = (await signInResponse.json()) as InternalSignInResponse;

  let meResponse: Response;
  try {
    meResponse = await fetch(`${getApiUrl()}/internal/me`, {
      headers: { Authorization: `Bearer ${result.idToken}` },
      cache: "no-store",
    });
  } catch {
    return {
      error: "Could not reach the server. Check your connection and try again.",
    };
  }

  if (!meResponse.ok) {
    // Authenticated, but not an ACTIVE internal user — no session is
    // established.
    return {
      error: "This account is not permitted to access the internal area.",
    };
  }

  const cookieStore = await cookies();
  cookieStore.set(INTERNAL_SESSION_COOKIE, result.idToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: result.expiresInSeconds,
  });

  redirect("/admin/orders");
}

// Clears the internal browser session (the HttpOnly cookie). After this the
// browser sends no internal token, so getInternalSession() and every /admin
// page treat the caller as signed out immediately. Like the customer
// sign-out, this does not revoke the underlying token server-side — that is
// deferred to a later Milestone 5 slice.
export async function internalSignOutAction(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(INTERNAL_SESSION_COOKIE);
  redirect("/internal/sign-in");
}
