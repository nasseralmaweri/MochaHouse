import type { Prisma } from '@mocha-house/database';

// The privileged corporate Administration-management permissions. Since
// Milestone 5E-4 there are two: managing whether a person may sign in
// (`users.manage_status`) and managing what access a person holds
// (`users.manage_roles`). A "protected administrator" is an ACTIVE internal
// user who EFFECTIVELY holds BOTH at CORPORATE scope — someone who can keep
// the Administration area running on their own.
//
// This is ONE shared definition so the two write paths that must not strand
// the platform without an administrator — the Milestone 5E-3 status change
// and the Milestone 5E-4 assignment removal — never drift apart. It is
// STRICTER than the original 5E-3 rule, which considered only
// `users.manage_status`: a hypothetical role that granted just one of the
// two keys no longer makes its holder a protected administrator. In the
// shipped configuration only `platform-administrator` grants either key and
// it grants both, so this tightening changes no real-world outcome; it only
// makes the two paths agree.
export const PROTECTED_ADMIN_PERMISSION_KEYS = [
  'users.manage_status',
  'users.manage_roles',
] as const;

// A Prisma `InternalUser` filter matching a protected administrator. It
// mirrors AuthorizationService.toValidScopeGrant: only a well-formed
// CORPORATE assignment (scopeId IS NULL) to a role that actually stores the
// exact permission key counts. A LOCATION grant, a malformed
// CORPORATE-with-scopeId row, an unknown permission key, and a non-ACTIVE
// user all fail this filter — never a role display name.
export function protectedAdminWhere(): Prisma.InternalUserWhereInput {
  return {
    status: 'ACTIVE',
    AND: PROTECTED_ADMIN_PERMISSION_KEYS.map(
      (permissionKey): Prisma.InternalUserWhereInput => ({
        roleAssignments: {
          some: {
            scopeType: 'CORPORATE',
            scopeId: null,
            role: { permissions: { some: { permissionKey } } },
          },
        },
      }),
    ),
  };
}

// Whether removing this one assignment would strip protected-administrator
// capability from its holder — i.e. it is a well-formed CORPORATE grant to a
// role that carries at least one protected permission. A LOCATION
// assignment never does. Used to decide whether the last-independent-admin
// rule needs to run before a removal.
export function assignmentCarriesProtectedAdminCapability(assignment: {
  scopeType: string;
  scopeId: string | null;
  role: { permissions: { permissionKey: string }[] };
}): boolean {
  if (assignment.scopeType !== 'CORPORATE' || assignment.scopeId !== null) {
    return false;
  }
  const keys = new Set(assignment.role.permissions.map((p) => p.permissionKey));
  return PROTECTED_ADMIN_PERMISSION_KEYS.some((key) => keys.has(key));
}
