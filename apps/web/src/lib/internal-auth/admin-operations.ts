import "server-only";
import type { OpeningChecklistResponse } from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";

// Server-only read of the authorized Opening Checklist API for the
// Operations "Today" card. Attaches the internal bearer token server-side
// (never exposed to the browser). A GET lazily creates today's checklist —
// see the API — so merely viewing Today creates today's instance for the
// location, which is the intended behaviour (there is no separate "start"
// action).
function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type OpeningChecklistSnapshotResult =
  | { outcome: "success"; checklist: OpeningChecklistResponse }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "error" };

export async function getOpeningChecklist(
  locationId: string,
): Promise<OpeningChecklistSnapshotResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await fetch(
      `${getApiUrl()}/admin/operations/opening-checklist?locationId=${encodeURIComponent(
        locationId,
      )}`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
    );
  } catch {
    return { outcome: "error" };
  }

  if (response.status === 401) {
    return { outcome: "unauthenticated" };
  }
  if (response.status === 403) {
    return { outcome: "forbidden" };
  }
  if (!response.ok) {
    return { outcome: "error" };
  }

  return {
    outcome: "success",
    checklist: (await response.json()) as OpeningChecklistResponse,
  };
}
