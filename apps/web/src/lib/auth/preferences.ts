import "server-only";
import type {
  CustomerCommunicationPreferences,
  CustomerUpdateCommunicationPreferencesRequest,
} from "@mocha-house/contracts";

// "server-only": raw bearer token + server-only API_URL. Mirrors
// lib/auth/profile.ts.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type PreferencesResult =
  | { outcome: "success"; preferences: CustomerCommunicationPreferences }
  | { outcome: "unauthorized" }
  | { outcome: "error" };

export async function getCommunicationPreferences(
  token: string,
): Promise<PreferencesResult> {
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/customers/me/preferences`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    return { outcome: "error" };
  }
  if (response.status === 401) {
    return { outcome: "unauthorized" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }
  return {
    outcome: "success",
    preferences: (await response.json()) as CustomerCommunicationPreferences,
  };
}

export type UpdatePreferencesResult =
  | { outcome: "success"; preferences: CustomerCommunicationPreferences }
  | { outcome: "unauthorized" }
  | { outcome: "invalid"; message: string }
  | { outcome: "error" };

export async function updateCommunicationPreferences(
  token: string,
  input: CustomerUpdateCommunicationPreferencesRequest,
): Promise<UpdatePreferencesResult> {
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/customers/me/preferences`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
      cache: "no-store",
    });
  } catch {
    return { outcome: "error" };
  }
  if (response.status === 401) {
    return { outcome: "unauthorized" };
  }
  if (response.status === 400) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    return {
      outcome: "invalid",
      message: body?.message ?? "That preference value can't be saved.",
    };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }
  return {
    outcome: "success",
    preferences: (await response.json()) as CustomerCommunicationPreferences,
  };
}
