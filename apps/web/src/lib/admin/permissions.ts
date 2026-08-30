import type { InternalPermissionKey } from "@mocha-house/contracts";

// Convenience only. Backend enforcement (PermissionGuard + service scope
// checks) remains the sole authority — this just decides whether the Admin
// UI renders a control the user could actually use.
//
// `permissions` is the flat effective list from GET /internal/me
// (authorization.permissions). Uses the controlled InternalPermissionKey
// type so a typo is a compile error.
export function can(
  permissions: readonly InternalPermissionKey[],
  required: InternalPermissionKey,
): boolean {
  return permissions.includes(required);
}

export function canAny(
  permissions: readonly InternalPermissionKey[],
  required: readonly InternalPermissionKey[],
): boolean {
  return required.some((key) => permissions.includes(key));
}
