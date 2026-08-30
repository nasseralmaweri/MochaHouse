import type {
  InternalAuthorizationSummary,
  InternalPermissionKey,
} from "@mocha-house/contracts";

// The per-permission capability map from GET /internal/me
// (authorization.capabilities). This module is the ONE place that reads its
// shape — components ask questions through these helpers, never by indexing
// the map themselves.
//
// Convenience only: the 5B backend (PermissionGuard + service scope checks)
// remains the sole authority. These helpers just decide whether the Admin
// UI renders a control the user could actually use, and at which location.
export type AdminCapabilities = InternalAuthorizationSummary["capabilities"];

// Does the user hold this permission at all (any scope)?
export function can(
  capabilities: AdminCapabilities,
  key: InternalPermissionKey,
): boolean {
  return capabilities[key] !== undefined;
}

// Does the user hold this permission at a corporate scope (i.e. for every
// location)?
export function isCorporateFor(
  capabilities: AdminCapabilities,
  key: InternalPermissionKey,
): boolean {
  return capabilities[key]?.corporate === true;
}

// Is this permission effective for THIS specific location? True when it is
// held corporately, or when locationId is one of its explicit LOCATION
// scopes. This never infers a permission's scope from the general
// authorized-location set.
export function canAtLocation(
  capabilities: AdminCapabilities,
  key: InternalPermissionKey,
  locationId: string,
): boolean {
  const capability = capabilities[key];
  if (!capability) {
    return false;
  }
  return capability.corporate || capability.locationIds.includes(locationId);
}

// The explicit LOCATION scopes for a permission ([] when it is corporate
// or not held). Callers that need "which of my locations does X apply to"
// should filter their location list with canAtLocation instead.
export function capabilityLocationIds(
  capabilities: AdminCapabilities,
  key: InternalPermissionKey,
): string[] {
  return capabilities[key]?.locationIds ?? [];
}
