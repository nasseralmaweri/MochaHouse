import "server-only";
import type { LocationSummary } from "@mocha-house/contracts";

// "server-only": attaches the raw bearer token to outgoing requests and
// reads the server-only API_URL — never for a browser bundle. Mirrors
// lib/auth/orders.ts and lib/auth/profile.ts.

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type PreferredLocationsResult =
  | { outcome: "success"; locations: LocationSummary[] }
  | { outcome: "unauthorized" }
  | { outcome: "error" };

async function readList(
  response: Response,
): Promise<PreferredLocationsResult> {
  if (response.status === 401) {
    return { outcome: "unauthorized" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }
  return {
    outcome: "success",
    locations: (await response.json()) as LocationSummary[],
  };
}

export async function getPreferredLocations(
  token: string,
): Promise<PreferredLocationsResult> {
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/customers/me/locations`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    return { outcome: "error" };
  }
  return readList(response);
}

export type AddPreferredLocationResult =
  | { outcome: "success"; locations: LocationSummary[] }
  | { outcome: "unauthorized" }
  | { outcome: "invalid"; message: string }
  | { outcome: "error" };

export async function addPreferredLocation(
  token: string,
  locationId: string,
): Promise<AddPreferredLocationResult> {
  let response: Response;
  try {
    response = await fetch(`${getApiUrl()}/customers/me/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ locationId }),
      cache: "no-store",
    });
  } catch {
    return { outcome: "error" };
  }

  if (response.status === 401) {
    return { outcome: "unauthorized" };
  }
  if (response.status === 400 || response.status === 404) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    return {
      outcome: "invalid",
      message: body?.message ?? "That location can't be saved.",
    };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }
  return {
    outcome: "success",
    locations: (await response.json()) as LocationSummary[],
  };
}

export async function removePreferredLocation(
  token: string,
  locationId: string,
): Promise<PreferredLocationsResult> {
  let response: Response;
  try {
    response = await fetch(
      `${getApiUrl()}/customers/me/locations/${encodeURIComponent(locationId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      },
    );
  } catch {
    return { outcome: "error" };
  }
  return readList(response);
}
