import {
  allowedScopeTypesFor,
  isKnownPermissionKey,
  type InternalPermissionKey,
} from '../../internal-auth/authorization/permission-catalog';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';

// Where an access level may be applied. This is ASSIGNMENT POLICY /
// presentation — it decides the SHAPE of a grant, never whether the caller
// is authorized to make it (that is the privilege ceiling below, driven
// entirely by the actor's effective permissions).
export type AccessAssignmentShape = 'corporate-only' | 'location-only';

// The access levels the platform ships with have a fixed, intentional
// shape. Encoding it by role KEY here is acceptable because authorization
// never derives from the key — only the WHERE-it-applies question does, and
// only for roles the platform itself defines.
const BUILT_IN_ASSIGNMENT_SHAPE: Record<string, AccessAssignmentShape> = {
  'platform-administrator': 'corporate-only',
  'store-manager': 'location-only',
};

// The built-in access levels offered for assignment. There is deliberately
// no path to create others: 5E-4 does not build custom role editing.
export const ASSIGNABLE_BUILT_IN_ROLE_KEYS = Object.keys(
  BUILT_IN_ASSIGNMENT_SHAPE,
);

// Resolve the assignment shape for a role, or null when it cannot be
// determined safely. A null shape means the role is not offered for
// assignment and the assign endpoint rejects it — we never guess.
export function resolveAssignmentShape(role: {
  key: string;
  permissionKeys: readonly string[];
}): AccessAssignmentShape | null {
  const fixed = BUILT_IN_ASSIGNMENT_SHAPE[role.key];
  if (fixed) {
    return fixed;
  }

  // Fallback for any non-built-in role: infer from its known permissions'
  // allowed scope types. Every key corporate-only => corporate-only; every
  // key location-capable => location-only; anything mixed or empty => null.
  const known = role.permissionKeys.filter(isKnownPermissionKey);
  if (known.length === 0) {
    return null;
  }
  const everyKeyCorporateOnly = known.every((key) => {
    const scopes = allowedScopeTypesFor(key);
    return scopes.length === 1 && scopes[0] === 'CORPORATE';
  });
  if (everyKeyCorporateOnly) {
    return 'corporate-only';
  }
  const everyKeyLocationCapable = known.every((key) =>
    allowedScopeTypesFor(key).includes('LOCATION'),
  );
  if (everyKeyLocationCapable) {
    return 'location-only';
  }
  return null;
}

// The PRIVILEGE CEILING. For every KNOWN permission the target access level
// carries, the acting administrator must already hold that permission at a
// scope broad enough to cover where it is being granted:
//   corporate grant  -> the actor must hold it at CORPORATE.
//   location grant   -> the actor must hold it at CORPORATE, or at that
//                       specific location.
// The caller must have already rejected any access level containing an
// unknown stored permission key (fail closed) before calling this.
export function actorCanGrant(
  actor: AuthorizationContext,
  roleKnownPermissionKeys: readonly InternalPermissionKey[],
  target:
    | { kind: 'corporate' }
    | { kind: 'locations'; locationIds: readonly string[] },
): boolean {
  for (const key of roleKnownPermissionKeys) {
    if (target.kind === 'corporate') {
      if (actor.authorizedLocations(key).kind !== 'all') {
        return false;
      }
      continue;
    }
    for (const locationId of target.locationIds) {
      if (!actor.canActOnLocation(key, locationId)) {
        return false;
      }
    }
  }
  return true;
}
