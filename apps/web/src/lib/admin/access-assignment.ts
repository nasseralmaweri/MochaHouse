import type {
  AdminAccessAssignmentShape,
  AdminAssignInternalUserRoleRequest,
} from "@mocha-house/contracts";
import { checkAccessChangeReason } from "./user-access";

// Client-side shaping + validation for the "Add access" form (Milestone
// 5E-4). Pure logic, unit-tested. The API re-validates everything; this
// only keeps the UI honest and turns the form's "access level / where /
// reason" fields into the request contract. It never produces permission
// keys, a role key or a scope enum the user chose directly.

export function accessLevelNeedsLocations(
  shape: AdminAccessAssignmentShape | null,
): boolean {
  return shape === "location-only";
}

export type AssignFormCheck =
  | { ok: true; request: AdminAssignInternalUserRoleRequest }
  | { ok: false; error: string };

export function buildAssignRoleRequest(input: {
  roleId: string | null;
  shape: AdminAccessAssignmentShape | null;
  locationIds: string[];
  reason: string;
}): AssignFormCheck {
  if (!input.roleId || !input.shape) {
    return { ok: false, error: "Choose an access level." };
  }

  const reason = checkAccessChangeReason(input.reason);
  if (!reason.ok) {
    return { ok: false, error: reason.error };
  }

  if (input.shape === "corporate-only") {
    return {
      ok: true,
      request: {
        roleId: input.roleId,
        scope: { kind: "corporate" },
        reason: reason.reason,
      },
    };
  }

  const locationIds = [...new Set(input.locationIds)];
  if (locationIds.length === 0) {
    return { ok: false, error: "Choose at least one location." };
  }

  return {
    ok: true,
    request: {
      roleId: input.roleId,
      scope: { kind: "locations", locationIds },
      reason: reason.reason,
    },
  };
}
