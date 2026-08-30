import {
  INTERNAL_PERMISSION_KEYS,
  INTERNAL_PERMISSION_METADATA,
  type InternalPermissionKey,
  type InternalScopeType,
} from '@mocha-house/contracts';

// The closed permission vocabulary, re-exported from the shared contract so
// the rest of the internal-auth module has one import site for it. A
// permission string is a real server capability ONLY if it appears here and
// some code checks it — the database never defines capabilities.
export {
  INTERNAL_PERMISSION_KEYS,
  INTERNAL_PERMISSION_METADATA,
  type InternalPermissionKey,
  type InternalScopeType,
};

const KNOWN_KEYS: ReadonlySet<string> = new Set(INTERNAL_PERMISSION_KEYS);

// True only for a key in the closed vocabulary. Used when building an
// authorization context from stored rows: an unrecognised stored
// permissionKey is dropped, never honoured — it cannot grant a capability
// because nothing implements it, and silently ignoring it is the safe
// failure mode.
export function isKnownPermissionKey(
  key: string,
): key is InternalPermissionKey {
  return KNOWN_KEYS.has(key);
}

// The scope types through which a given permission may legitimately be
// granted. A permission held only via an assignment whose scopeType is not
// in this list does not authorize the action (e.g. a LOCATION-scoped
// assignment can never satisfy the CORPORATE-only master catalog
// permissions).
export function allowedScopeTypesFor(
  key: InternalPermissionKey,
): readonly InternalScopeType[] {
  return INTERNAL_PERMISSION_METADATA[key].allowedScopeTypes;
}
