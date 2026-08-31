import type { LocationSummary } from "@mocha-house/contracts";
import { canAtLocation, type AdminCapabilities } from "./capabilities";
import type { AdminLocationContext } from "./location-context";

// Pure view-model logic for the Store Operations "Today" workspace
// (Milestone 6A). Framework-free by design, like the rest of lib/admin —
// the page component (app/admin/operations/page.tsx) renders whatever this
// returns. It makes NO authorization decision of its own: it only reads the
// already-resolved location context and the capability map the Admin shell
// was given, and every server/API read the page performs is still guarded
// independently.

// The resolved state for one render of the Operations Today page.
//   forbidden-location — an explicit ?location the viewer isn't authorized
//                        for (never silently switch — show access denied).
//   no-location        — the viewer has no authorized location at all.
//   pick-location      — a corporate viewer with no specific location
//                        chosen. Operations is per store; prompt for one
//                        rather than inventing a global operations view.
//   ready              — one concrete location; render the day's picture.
export type OperationsTodayState =
  | { kind: "forbidden-location" }
  | { kind: "no-location" }
  | { kind: "pick-location" }
  | {
      kind: "ready";
      location: LocationSummary;
      // "Today at Mocha House - Dearborn Heights"
      locationHeading: string;
      // Whether the page should load and show the order-queue snapshot.
      // TRUE ONLY when the viewer holds `orders.view` for THIS location.
      // `operations.view` on its own never unlocks order information — the
      // page must still work (and simply omit the snapshot) without it.
      showOrderSnapshot: boolean;
    };

export function resolveOperationsTodayView(input: {
  locationContext: AdminLocationContext;
  capabilities: AdminCapabilities;
}): OperationsTodayState {
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
        location: locationContext.location,
        locationHeading: `Today at ${locationContext.location.name}`,
        showOrderSnapshot: canAtLocation(
          capabilities,
          "orders.view",
          locationContext.location.id,
        ),
      };
  }
}

// A plain-language date for the "Today" heading. Presentation only —
// Milestone 6A deliberately does NOT model a per-location timezone or
// business-day boundary (there is no such field on Location, and the store
// order queue already renders times in the viewer's local zone). This
// formats the given instant in the viewer/server locale; a concrete
// operational workflow that actually depends on "which business day is it"
// is what will justify a timezone/business-day model later, not this view.
export function formatOperationsToday(
  now: Date,
  locale?: string | string[],
  timeZone?: string,
): string {
  return now.toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  });
}
