import type {
  OpeningChecklistProgress,
  OpeningChecklistResponse,
} from "@mocha-house/contracts";
import { canAtLocation, type AdminCapabilities } from "./capabilities";
import type { AdminLocationContext } from "./location-context";

// Framework-free view-model logic for the Opening Checklist page
// (Milestone 6B), matching the rest of lib/admin. It makes NO authorization
// decision of its own — every API call the page performs is still guarded
// server-side. It only decides what the page renders from the
// already-resolved location context and capability map.

// The resolved state for one render of the Opening Checklist page. Mirrors
// resolveOperationsTodayView: the page is per store, so a corporate viewer
// with no location chosen is prompted for one rather than shown a global
// checklist.
export type OpeningChecklistPageState =
  | { kind: "forbidden-location" }
  | { kind: "no-location" }
  | { kind: "pick-location" }
  | {
      kind: "ready";
      locationId: string;
      locationName: string;
      // TRUE only when the viewer holds operations.tasks.complete for THIS
      // location. A viewer with only operations.view sees the checklist and
      // completion state but no usable Complete / Undo controls.
      canComplete: boolean;
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
      };
  }
}

// "12 of 23 complete" — the only progress phrasing. No percentage, no
// score, no threshold.
export function formatChecklistProgress(
  progress: OpeningChecklistProgress,
): string {
  return `${progress.completed} of ${progress.total} complete`;
}

// One checklist item, prepared for rendering. `showComplete` / `showUndo`
// are mutually exclusive and both false for a read-only viewer.
export interface OpeningChecklistItemViewModel {
  id: string;
  label: string;
  completed: boolean;
  completedByName: string | null;
  completedAt: string | null;
  showComplete: boolean;
  showUndo: boolean;
}

export interface OpeningChecklistViewModel {
  title: string;
  businessDate: string;
  locationName: string;
  progress: OpeningChecklistProgress;
  progressLabel: string;
  isComplete: boolean;
  // A read-only viewer (operations.view but not operations.tasks.complete)
  // sees the checklist with no operable controls.
  readOnly: boolean;
  sections: {
    name: string;
    items: OpeningChecklistItemViewModel[];
  }[];
}

// Build the page view-model from the authoritative API projection. The
// grouping/order is the API's — this never invents sections or items, and
// adds nothing beyond per-item control visibility.
export function buildOpeningChecklistViewModel(
  checklist: OpeningChecklistResponse,
  options: { canComplete: boolean },
): OpeningChecklistViewModel {
  const { canComplete } = options;

  return {
    title: checklist.title,
    businessDate: checklist.businessDate,
    locationName: checklist.locationName,
    progress: checklist.progress,
    progressLabel: formatChecklistProgress(checklist.progress),
    isComplete: checklist.progress.isComplete,
    readOnly: !canComplete,
    sections: checklist.sections.map((section) => ({
      name: section.name,
      items: section.items.map((item) => ({
        id: item.id,
        label: item.label,
        completed: item.completed,
        completedByName: item.completedBy?.name ?? null,
        completedAt: item.completedAt,
        showComplete: canComplete && !item.completed,
        showUndo: canComplete && item.completed,
      })),
    })),
  };
}
