"use server";

import type {
  OwnerRegistrationCompleteRequest,
  OwnerRegistrationStartRequest,
} from "@mocha-house/contracts";
import { serverActionClientIpHeaders } from "@/lib/client-ip-forwarding";
import {
  afterComplete,
  afterStart,
  readApiMessage,
  type ApiAnswer,
  type RegistrationState,
} from "./registration-state";

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

async function post(path: string, body: unknown): Promise<ApiAnswer | null> {
  try {
    const response = await fetch(`${getApiUrl()}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await serverActionClientIpHeaders()),
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    return {
      status: response.status,
      message: readApiMessage(await response.json().catch(() => null)),
    };
  } catch {
    return null;
  }
}

// SC4a — the owner registration form (/internal/register). Posted
// server-side; the API decides everything (whether registration is enabled,
// whether a code is sent, whether it is right). Nothing about the account is
// stored in the browser: registration establishes no session.
export async function ownerRegistrationAction(
  previous: RegistrationState,
  formData: FormData,
): Promise<RegistrationState> {
  const intent = String(formData.get("intent") ?? "");

  if (intent === "start") {
    const email = String(formData.get("email") ?? "").trim();
    if (!email) return { step: "email", email, error: "Enter your email." };
    const request: OwnerRegistrationStartRequest = { email };
    return afterStart(
      email,
      await post("/internal/registration/start", request),
      "email",
    );
  }

  if (previous.step !== "code") return previous;
  const { email } = previous;

  if (intent === "resend") {
    const request: OwnerRegistrationStartRequest = { email };
    return afterStart(
      email,
      await post("/internal/registration/start", request),
      "code",
    );
  }

  if (intent === "change-email") {
    return { step: "email", email, error: null };
  }

  if (intent === "complete") {
    const password = String(formData.get("password") ?? "");
    if (password !== String(formData.get("confirmPassword") ?? "")) {
      return {
        step: "code",
        email,
        error: "The passwords don't match.",
        notice: null,
      };
    }
    const request: OwnerRegistrationCompleteRequest = {
      email,
      code: String(formData.get("code") ?? ""),
      password,
      displayName: String(formData.get("displayName") ?? ""),
      termsVersion: String(formData.get("termsVersion") ?? ""),
      privacyVersion: String(formData.get("privacyVersion") ?? ""),
      acceptLegal: formData.get("acceptLegal") === "on",
    };
    return afterComplete(
      email,
      await post("/internal/registration/complete", request),
    );
  }

  return previous;
}
