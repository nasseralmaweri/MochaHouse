import "server-only";
import type {
  OpeningChecklistResponse,
  OperationsTasksResponse,
} from "@mocha-house/contracts";
import { getInternalSessionToken } from "./session";
import { internalAuthHeaders } from "./active-business";

// Server-only read of an authorized daily-checklist API for the Operations
// "Today" cards (Opening — 6B; Closing — 6D). Attaches the internal bearer
// token server-side (never exposed to the browser). A GET lazily creates
// today's checklist — see the API — so merely viewing Today creates
// today's instance for the location, which is the intended behaviour
// (there is no separate "start" action).
type ChecklistKind = "opening" | "closing";

function getApiUrl(): string {
  const apiUrl = process.env.API_URL;
  if (!apiUrl) {
    throw new Error(
      "API_URL environment variable is not set. See apps/web/.env.example.",
    );
  }
  return apiUrl;
}

export type ChecklistSnapshotResult =
  | { outcome: "success"; checklist: OpeningChecklistResponse }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "error" };

export async function getChecklistSnapshot(
  checklist: ChecklistKind,
  locationId: string,
): Promise<ChecklistSnapshotResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await fetch(
      `${getApiUrl()}/admin/operations/${checklist}-checklist?locationId=${encodeURIComponent(
        locationId,
      )}`,
      { headers: await internalAuthHeaders(token), cache: "no-store" },
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

export type OperationsTasksSnapshotResult =
  | { outcome: "success"; tasks: OperationsTasksResponse }
  | { outcome: "unauthenticated" }
  | { outcome: "forbidden" }
  | { outcome: "error" };

// Server-side read of today's operational tasks for one location (the
// Overview's open-task count). A plain GET of the existing tasks endpoint —
// the Operations screen reads it the same way from the browser.
export async function getOperationsTasksSnapshot(
  locationId: string,
): Promise<OperationsTasksSnapshotResult> {
  const token = await getInternalSessionToken();
  if (!token) {
    return { outcome: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await fetch(
      `${getApiUrl()}/admin/operations/tasks?locationId=${encodeURIComponent(
        locationId,
      )}`,
      { headers: await internalAuthHeaders(token), cache: "no-store" },
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
    tasks: (await response.json()) as OperationsTasksResponse,
  };
}
