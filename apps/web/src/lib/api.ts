import type {
  LocationMenuResponse,
  LocationSummary,
} from "@mocha-house/contracts";

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

export async function getLocationMenu(
  locationId: string,
): Promise<LocationMenuResponse | null> {
  const response = await fetch(
    `${getApiUrl()}/locations/${locationId}/menu`,
  );

  if (!response.ok) {
    throw new Error(`Failed to load location menu (${response.status}).`);
  }

  // The API returns an empty 200 body (not JSON "null") when there is no
  // effective menu for this location, so response.json() would throw.
  const body = await response.text();
  return body ? (JSON.parse(body) as LocationMenuResponse) : null;
}
