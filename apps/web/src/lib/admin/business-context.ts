import type { InternalBusinessSummary } from "@mocha-house/contracts";

// The resolved active business for an Admin render (Milestone S0F contract).
//   active              — one business the user may enter.
//   selection-required  — several enterable businesses and no valid choice.
//   none                — the user can enter no business at all.
// The cookie is INTENT only: it is honoured solely when it names a business
// in the list the API just returned for this identity. The API re-validates
// membership on every request regardless.
export type ActiveBusinessResolution =
  | { kind: "active"; business: InternalBusinessSummary }
  | { kind: "selection-required"; businesses: InternalBusinessSummary[] }
  | { kind: "none" };

export function resolveActiveBusiness(
  businesses: readonly InternalBusinessSummary[],
  cookieBusinessId: string | null | undefined,
): ActiveBusinessResolution {
  if (cookieBusinessId) {
    const chosen = businesses.find((b) => b.id === cookieBusinessId);
    if (chosen) {
      return { kind: "active", business: chosen };
    }
    // stale / no-longer-authorized cookie: ignore and fall through
  }
  if (businesses.length === 1) {
    return { kind: "active", business: businesses[0] };
  }
  if (businesses.length === 0) {
    return { kind: "none" };
  }
  return { kind: "selection-required", businesses: [...businesses] };
}
