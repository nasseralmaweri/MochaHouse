import type {
  LocationMenuResponse,
  LocationSummary,
  PublicJobOpeningDetail,
  PublicJobOpeningsResponse,
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

// --- Public Careers (Milestone 8B) --------------------------------
// The API only ever returns publicly-visible openings (PUBLISHED +
// corporate or active-location); a non-visible job is 404 from the detail
// endpoint. `getPublicJobOpening` returns null on 404 so the page can render
// notFound().

export async function getPublicJobOpenings(): Promise<PublicJobOpeningsResponse> {
  const response = await fetch(`${getApiUrl()}/careers/jobs`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Failed to load job openings (${response.status}).`);
  }
  return response.json() as Promise<PublicJobOpeningsResponse>;
}

export async function getPublicJobOpening(
  jobId: string,
): Promise<PublicJobOpeningDetail | null> {
  const response = await fetch(
    `${getApiUrl()}/careers/jobs/${encodeURIComponent(jobId)}`,
    { cache: "no-store" },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to load job opening (${response.status}).`);
  }
  return response.json() as Promise<PublicJobOpeningDetail>;
}
