import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AdminRoleDetail,
  AdminRoleSummary,
  InternalPermissionKey,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { isKnownPermissionKey } from '../../internal-auth/authorization/permission-catalog';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { describeAccessLevelCapabilities } from './capability-presentation';

// Read-only Admin view of access levels — InternalRole records — for
// Administration → Access Levels (Milestone 5E-2). Guarded by
// InternalAuthGuard + PermissionGuard + `roles.view` (CORPORATE-only) at the
// controller; `assertCorporate` here is the matching service-layer defense.
//
// `isSystem` is surfaced only as `isBuiltIn` presentation metadata — it
// currently enforces nothing. The capability list is derived purely from the
// role's stored KNOWN permission keys via the shared presentation helper;
// the role display name never influences it, and unknown stored keys are
// omitted (fail-closed).
@Injectable()
export class AdminInternalRolesService {
  constructor(private readonly prisma: PrismaService) {}

  async listRoles(
    authorization: AuthorizationContext,
  ): Promise<AdminRoleSummary[]> {
    authorization.assertCorporate('roles.view');

    const roles = await this.prisma.internalRole.findMany({
      select: {
        id: true,
        displayName: true,
        description: true,
        isSystem: true,
      },
    });

    // One query for every assignment, grouped in memory into a distinct
    // people-per-role count (a person holding a role at several locations
    // counts once).
    const assignments = await this.prisma.internalUserRoleAssignment.findMany({
      select: { roleId: true, internalUserId: true },
    });
    const peopleByRole = new Map<string, Set<string>>();
    for (const assignment of assignments) {
      const set = peopleByRole.get(assignment.roleId) ?? new Set<string>();
      set.add(assignment.internalUserId);
      peopleByRole.set(assignment.roleId, set);
    }

    return roles
      .map((role) => ({
        id: role.id,
        displayName: role.displayName,
        description: role.description,
        isBuiltIn: role.isSystem,
        userCount: peopleByRole.get(role.id)?.size ?? 0,
      }))
      .sort(
        (a, b) =>
          a.displayName.localeCompare(b.displayName) ||
          a.id.localeCompare(b.id),
      );
  }

  async getRoleDetail(
    internalRoleId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminRoleDetail> {
    authorization.assertCorporate('roles.view');

    const role = await this.prisma.internalRole.findUnique({
      where: { id: internalRoleId },
      select: {
        id: true,
        displayName: true,
        description: true,
        isSystem: true,
        permissions: { select: { permissionKey: true } },
        _count: { select: { assignments: true } },
      },
    });

    if (!role) {
      throw new NotFoundException('Access level not found.');
    }

    const peopleWithRole =
      await this.prisma.internalUserRoleAssignment.findMany({
        where: { roleId: internalRoleId },
        select: { internalUserId: true },
      });
    const userCount = new Set(peopleWithRole.map((row) => row.internalUserId))
      .size;

    // Only KNOWN permission keys become capability lines — an unrecognised
    // stored key grants nothing (there is no code path that honours it) and
    // must never be shown as a real capability.
    const knownKeys = new Set<InternalPermissionKey>(
      role.permissions
        .map((permission) => permission.permissionKey)
        .filter((key): key is InternalPermissionKey =>
          isKnownPermissionKey(key),
        ),
    );

    return {
      id: role.id,
      displayName: role.displayName,
      description: role.description,
      isBuiltIn: role.isSystem,
      userCount,
      capabilities: describeAccessLevelCapabilities(knownKeys),
    };
  }
}
