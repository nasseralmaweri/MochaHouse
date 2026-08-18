import type { LocationSummary } from "@mocha-house/contracts";

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;

  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }

  return apiUrl;
}

export async function getLocations(): Promise<LocationSummary[]> {
  const response = await fetch(`${getApiUrl()}/locations`);

  if (!response.ok) {
    throw new Error(`Failed to load locations (${response.status}).`);
  }

  return response.json() as Promise<LocationSummary[]>;
}
