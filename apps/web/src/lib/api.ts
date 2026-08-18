import type {
  LocationMenuResponse,
  LocationSummary,
} from "@mocha-house/contracts";
import { parseLocationMenuResponse } from "@/lib/menu";

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

  return parseLocationMenuResponse(response);
}
