import type { LocationSummary } from "@mocha-house/contracts";

// The sentinel used in `?location=` and in the mh_admin_location cookie for
// the corporate / all-locations context.
export const CORPORATE_LOCATION_VALUE = "corporate";

// The resolved Admin location context for a page render.
//   corporate  — "Corporate / All locations" (only reachable by a user with
//                a CORPORATE grant). Dashboard-level pages accept this;
//                per-location pages (Orders) prompt for a concrete location.
//   location   — one concrete authorized location.
//   forbidden  — an explicit ?location=<id> the user is NOT authorized for.
//                The page must show an access-denied state, NOT silently
//                switch to another location.
//   none       — the user has no authorized locations at all (e.g. an
//                ACTIVE user with no role assignments).
export type AdminLocationContext =
  | { kind: "corporate" }
  | { kind: "location"; location: LocationSummary }
  | { kind: "forbidden"; requestedId: string }
  | { kind: "none" };

export interface ResolveLocationContextInput {
  authorizedLocations: readonly LocationSummary[];
  isCorporate: boolean;
  // From ?location=<value> — explicit / deep-link intent. Wins when valid.
  urlLocationId: string | null;
  // From the mh_admin_location preference cookie — a fallback only, and
  // only honoured when still present in the authorized set. NOT a security
  // boundary.
  cookieLocationId: string | null;
}

// Precedence:
//   1. explicit ?location — a real authorized location, or "corporate" for
//      a corporate user; anything else -> { forbidden }.
//   2. cookie preference — same validity rules; a stale/unauthorized value
//      is silently ignored (fall through), never forbidden.
//   3. defaults — corporate user -> corporate; exactly one authorized
//      location -> that one; several -> the first; none -> { none }.
export function resolveLocationContext(
  input: ResolveLocationContextInput,
): AdminLocationContext {
  const { authorizedLocations, isCorporate, urlLocationId, cookieLocationId } =
    input;

  const findLocation = (id: string): LocationSummary | null =>
    authorizedLocations.find((location) => location.id === id) ?? null;

  if (urlLocationId !== null && urlLocationId !== "") {
    if (urlLocationId === CORPORATE_LOCATION_VALUE) {
      return isCorporate
        ? { kind: "corporate" }
        : { kind: "forbidden", requestedId: urlLocationId };
    }
    const location = findLocation(urlLocationId);
    return location
      ? { kind: "location", location }
      : { kind: "forbidden", requestedId: urlLocationId };
  }

  if (cookieLocationId !== null && cookieLocationId !== "") {
    if (cookieLocationId === CORPORATE_LOCATION_VALUE && isCorporate) {
      return { kind: "corporate" };
    }
    const location = findLocation(cookieLocationId);
    if (location) {
      return { kind: "location", location };
    }
    // stale / no-longer-authorized cookie: ignore and fall through
  }

  if (isCorporate) {
    return { kind: "corporate" };
  }
  if (authorizedLocations.length >= 1) {
    return { kind: "location", location: authorizedLocations[0] };
  }
  return { kind: "none" };
}

// The value the location <select> should reflect for a given resolved
// context (used to keep the control and the URL in sync).
export function locationContextValue(context: AdminLocationContext): string {
  switch (context.kind) {
    case "corporate":
      return CORPORATE_LOCATION_VALUE;
    case "location":
      return context.location.id;
    case "forbidden":
      return context.requestedId;
    case "none":
      return "";
  }
}
