"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type {
  CustomerSignInRequest,
  CustomerSignInResponse,
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

export async function signOutAction(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(CUSTOMER_SESSION_COOKIE);
  redirect("/account/sign-in");
}
