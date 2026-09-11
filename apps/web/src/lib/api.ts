import type {
  FranchisingPageContent,
  LocationMenuResponse,
  LocationSummary,
  PublicCmsPageContentResponse,
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

// --- Public CMS content (Milestone 8E) -----------------------------
// Structured content for a small, code-defined set of page keys — NOT a
// page builder. `getPublishedFranchisingContent` NEVER throws: a missing
// key, no row, a draft-only page, or any fetch/parse failure all resolve
// to null so the calling page can fall back to its own hard-coded content.
// CMS failure must never break a public page.

export async function getPublishedFranchisingContent(): Promise<FranchisingPageContent | null> {
  try {
    const response = await fetch(`${getApiUrl()}/content/franchising`, {
      cache: "no-store",
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as PublicCmsPageContentResponse;
    return body?.content ?? null;
  } catch {
    return null;
  }
}
