import type {
  OpeningChecklistItemStatus,
  OpeningChecklistProgress,
  OpeningChecklistResponse,
} from "@mocha-house/contracts";
import { canAtLocation, type AdminCapabilities } from "./capabilities";
import type { AdminLocationContext } from "./location-context";

// Framework-free view-model logic for the Opening Checklist execution page
// (Milestone 6B; Milestone 6C adds the management exception). It makes NO
// authorization decision of its own — every API call the page performs is
// still guarded server-side. It only decides what the page renders from the
// already-resolved location context and capability map.

export type OpeningChecklistPageState =
  | { kind: "forbidden-location" }
  | { kind: "no-location" }
  | { kind: "pick-location" }
  | {
      kind: "ready";
      locationId: string;
      locationName: string;
      // TRUE only when the viewer holds operations.tasks.complete for THIS
      // location — the Complete / Undo controls.
      canComplete: boolean;
      // TRUE only when the viewer holds operations.exceptions.manage for
      // THIS location — the Log Exception / Clear Exception controls.
      canLogExceptions: boolean;
    };

export function resolveOpeningChecklistPage(input: {
  locationContext: AdminLocationContext;
  capabilities: AdminCapabilities;
}): OpeningChecklistPageState {
  const { locationContext, capabilities } = input;

  switch (locationContext.kind) {
    case "forbidden":
      return { kind: "forbidden-location" };
    case "none":
      return { kind: "no-location" };
    case "corporate":
      return { kind: "pick-location" };
    case "location":
      return {
        kind: "ready",
        locationId: locationContext.location.id,
        locationName: locationContext.location.name,
        canComplete: canAtLocation(
          capabilities,
          "operations.tasks.complete",
          locationContext.location.id,
        ),
        canLogExceptions: canAtLocation(
          capabilities,
          "operations.exceptions.manage",
          locationContext.location.id,
        ),
      };
  }
}

// "12 of 23 complete" — counts RESOLVED items (normal completion OR a
// management exception). No percentage, no score, no threshold.
export function formatChecklistProgress(
  progress: OpeningChecklistProgress,
): string {
  return `${progress.resolved} of ${progress.total} complete`;
}

// The outcome of one Opening Checklist API call, as the browser client
// reports it (mirrors OpeningChecklistResult in lib/api-client).
export type ChecklistLoadOutcome =
  | "success"
  | "forbidden"
  | "not-found"
  | "invalid"
  | "error";

// The load-state the Opening Checklist page tracks.
export type ChecklistLoadState = "ok" | "forbidden" | "error";

// Map an API outcome to the page's load-state. A failed load — a plain
// `error`, or a `not-found` with nothing already on screen — must reach
// `error` so the page renders its retryable error card, never staying on
// the loading skeleton. `invalid` (a rejected mutation) keeps the page:
// the loaded checklist is still valid and the message is shown inline.
export function nextChecklistLoadState(
  outcome: ChecklistLoadOutcome,
): ChecklistLoadState {
  switch (outcome) {
    case "success":
    case "invalid":
      return "ok";
    case "forbidden":
      return "forbidden";
    case "not-found":
    case "error":
      return "error";
  }
}

// One checklist item, prepared for rendering. `showComplete` / `showUndo` /
// `showLogException` / `showClearException` reflect exactly one available
// action for the current status and the viewer's permissions; all are
// false for a read-only viewer.
export interface OpeningChecklistItemViewModel {
  id: string;
  label: string;
  status: OpeningChecklistItemStatus;
  // Normal completion only — drives the ordinary checkmark.
  completed: boolean;
  completedByName: string | null;
  completedAt: string | null;
  // Present only when status === "exception".
  exception: { reason: string; byName: string | null; at: string } | null;
  showComplete: boolean;
  showUndo: boolean;
  showLogException: boolean;
  showClearException: boolean;
}

export interface OpeningChecklistViewModel {
  title: string;
  businessDate: string;
  locationName: string;
  progress: OpeningChecklistProgress;
  progressLabel: string;
  isComplete: boolean;
  // A viewer with neither operations.tasks.complete nor
  // operations.exceptions.manage for this location — no operable controls.
  readOnly: boolean;
  sections: {
    name: string;
    items: OpeningChecklistItemViewModel[];
  }[];
}

export function buildOpeningChecklistViewModel(
  checklist: OpeningChecklistResponse,
  options: { canComplete: boolean; canLogExceptions: boolean },
): OpeningChecklistViewModel {
  const { canComplete, canLogExceptions } = options;

  return {
    title: checklist.title,
    businessDate: checklist.businessDate,
    locationName: checklist.locationName,
    progress: checklist.progress,
    progressLabel: formatChecklistProgress(checklist.progress),
    isComplete: checklist.progress.isComplete,
    readOnly: !canComplete && !canLogExceptions,
    sections: checklist.sections.map((section) => ({
      name: section.name,
      items: section.items.map((item) => ({
        id: item.id,
        label: item.label,
        status: item.status,
        completed: item.completed,
        completedByName: item.completedBy?.name ?? null,
        completedAt: item.completedAt,
        exception: item.exception
          ? {
              reason: item.exception.reason,
              byName: item.exception.by?.name ?? null,
              at: item.exception.at,
            }
          : null,
        showComplete: canComplete && item.status === "open",
        showUndo: canComplete && item.status === "completed",
        showLogException: canLogExceptions && item.status === "open",
        showClearException: canLogExceptions && item.status === "exception",
      })),
    })),
  };
}
