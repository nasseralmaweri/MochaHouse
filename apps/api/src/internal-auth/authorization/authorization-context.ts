import { ForbiddenException } from '@nestjs/common';
import {
  allowedScopeTypesFor,
  type InternalPermissionKey,
  type InternalScopeType,
} from './permission-catalog';

// One scope through which a permission is granted to a user.
//   CORPORATE -> scopeId is null; applies to every current location.
//   LOCATION  -> scopeId is a Location id; applies to that location only.
export interface ScopeGrant {
  scopeType: InternalScopeType;
  scopeId: string | null;
}

// The set of locations a permission is authorized for.
//   { kind: 'all' }              -> a CORPORATE grant exists for the key.
//   { kind: 'locations', ids }   -> only these specific locations.
//   { kind: 'none' }             -> the user cannot use this permission
//                                   through any valid scope.
export type AuthorizedLocations =
  | { kind: 'all' }
  | { kind: 'locations'; locationIds: ReadonlySet<string> }
  | { kind: 'none' };

// The authenticated internal user's effective grants — a pure value object,
// framework-neutral apart from throwing Nest's ForbiddenException from the
// assert helpers (kept here so every enforcement site stays a one-liner and
// the 403 message is uniform). Built by AuthorizationService from
// InternalUser -> assignments -> role -> role permissions; never from a
// role name.
export class AuthorizationContext {
  private constructor(
    // key -> the scope grants through which the user holds it. Only ever
    // contains keys from the closed vocabulary (unknown stored keys are
    // dropped before construction).
    private readonly grants: ReadonlyMap<
      InternalPermissionKey,
      readonly ScopeGrant[]
    >,
  ) {}

  static create(
    grants: ReadonlyMap<InternalPermissionKey, readonly ScopeGrant[]>,
  ): AuthorizationContext {
    return new AuthorizationContext(grants);
  }

  // Test/bootstrap convenience: build a context from a plain description.
  static of(
    entries: Partial<Record<InternalPermissionKey, ScopeGrant[]>>,
  ): AuthorizationContext {
    const map = new Map<InternalPermissionKey, readonly ScopeGrant[]>();
    for (const [key, value] of Object.entries(entries)) {
      if (value) {
        map.set(key as InternalPermissionKey, value);
      }
    }
    return new AuthorizationContext(map);
  }

  static empty(): AuthorizationContext {
    return new AuthorizationContext(new Map());
  }

  // The grants for a key that are through a scope type the permission
  // actually permits. A CORPORATE-only permission held via a LOCATION
  // assignment yields [] here.
  private effectiveGrants(key: InternalPermissionKey): readonly ScopeGrant[] {
    const allowed = allowedScopeTypesFor(key);
    return (this.grants.get(key) ?? []).filter((g) =>
      allowed.includes(g.scopeType),
    );
  }

  // Does the user hold this permission in a way that can actually authorize
  // an action — i.e. through at least one valid, well-formed scope grant?
  // This is the coarse check PermissionGuard uses; it is kept consistent
  // with authorizedLocations (a permission that resolves to no locations is
  // not "held").
  has(key: InternalPermissionKey): boolean {
    return this.authorizedLocations(key).kind !== 'none';
  }

  // The locations this permission is authorized for.
  authorizedLocations(key: InternalPermissionKey): AuthorizedLocations {
    const grants = this.effectiveGrants(key);
    if (grants.length === 0) {
      return { kind: 'none' };
    }
    if (grants.some((g) => g.scopeType === 'CORPORATE')) {
      return { kind: 'all' };
    }
    const locationIds = new Set<string>();
    for (const grant of grants) {
      if (grant.scopeType === 'LOCATION' && grant.scopeId) {
        locationIds.add(grant.scopeId);
      }
    }
    return locationIds.size > 0
      ? { kind: 'locations', locationIds }
      : { kind: 'none' };
  }

  canActOnLocation(key: InternalPermissionKey, locationId: string): boolean {
    const authorized = this.authorizedLocations(key);
    if (authorized.kind === 'all') {
      return true;
    }
    if (authorized.kind === 'locations') {
      return authorized.locationIds.has(locationId);
    }
    return false;
  }

  // Enforcement helper for a location-scoped operation: the caller must
  // hold `key` for `locationId` (CORPORATE covers every location). Throws a
  // uniform 403 otherwise — before any resource is read.
  assertCanActOnLocation(key: InternalPermissionKey, locationId: string): void {
    if (!this.canActOnLocation(key, locationId)) {
      throw new ForbiddenException(
        'You are not authorized to perform this action for this location.',
      );
    }
  }

  // Enforcement helper for a global (non-location) operation: the user must
  // hold `key` at CORPORATE scope.
  assertCorporate(key: InternalPermissionKey): void {
    const grants = this.effectiveGrants(key);
    if (!grants.some((g) => g.scopeType === 'CORPORATE')) {
      throw new ForbiddenException(
        'This action requires a corporate-scoped permission.',
      );
    }
  }

  // A DERIVED, read-only projection for the Admin shell (Milestone 5C). It
  // never exposes role names/ids or raw grant rows — only:
  //   permissions  — the effective keys the user holds through a valid
  //                  scope type (same "held" definition the guard uses).
  //   isCorporate  — the user has at least one CORPORATE-scoped grant.
  //   locationIds  — the union of Location ids referenced by the user's
  //                  LOCATION grants (the caller resolves these to active
  //                  Location rows; a CORPORATE user is given every active
  //                  location instead).
  // This changes no authorization decision — it only summarises the context
  // that assertCanActOnLocation / assertCorporate already enforce.
  summarize(): {
    permissions: InternalPermissionKey[];
    isCorporate: boolean;
    locationIds: string[];
  } {
    const permissions: InternalPermissionKey[] = [];
    const locationIds = new Set<string>();
    let isCorporate = false;

    for (const key of this.grants.keys()) {
      const effective = this.effectiveGrants(key);
      if (effective.length === 0) {
        continue;
      }
      permissions.push(key);
      for (const grant of effective) {
        if (grant.scopeType === 'CORPORATE') {
          isCorporate = true;
        } else if (grant.scopeType === 'LOCATION' && grant.scopeId) {
          locationIds.add(grant.scopeId);
        }
      }
    }

    return {
      permissions: permissions.sort(),
      isCorporate,
      locationIds: [...locationIds].sort(),
    };
  }
}
