import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AdminInternalUserDetail,
  AdminInternalUserSummary,
  AdminUserLocationAccess,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthorizationService } from '../../internal-auth/authorization/authorization.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { describeEffectiveCapabilities } from './capability-presentation';

type AssignmentRow = {
  scopeType: 'CORPORATE' | 'LOCATION';
  scopeId: string | null;
  role: { displayName: string };
};

// Read-only Admin view of internal users (Milestone 5E-1). Guarded by
// InternalAuthGuard + PermissionGuard + `users.view` (CORPORATE-only) at the
// controller; `assertCorporate` here is the matching service-layer defense.
//
// This is NOT a second authorization engine: the "What they can do" list is
// derived from the SAME AuthorizationService / AuthorizationContext the
// guards use. Role display names are shown as labels only and never
// influence the capability list.
@Injectable()
export class AdminInternalUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorizationService: AuthorizationService,
  ) {}

  async listUsers(
    authorization: AuthorizationContext,
  ): Promise<AdminInternalUserSummary[]> {
    authorization.assertCorporate('users.view');

    const users = await this.prisma.internalUser.findMany({
      select: {
        id: true,
        displayName: true,
        email: true,
        status: true,
        roleAssignments: {
          select: {
            scopeType: true,
            scopeId: true,
            role: { select: { displayName: true } },
          },
        },
      },
    });

    const locationNameById = await this.loadLocationNames(
      users.flatMap((user) => user.roleAssignments),
    );

    return users
      .map((user) =>
        this.toSummary(user, user.roleAssignments, locationNameById),
      )
      .sort(compareSummaries);
  }

  async getUserDetail(
    internalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminInternalUserDetail> {
    authorization.assertCorporate('users.view');

    const user = await this.prisma.internalUser.findUnique({
      where: { id: internalUserId },
      select: {
        id: true,
        displayName: true,
        email: true,
        status: true,
        roleAssignments: {
          select: {
            scopeType: true,
            scopeId: true,
            role: { select: { displayName: true } },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Internal user not found.');
    }

    const locationNameById = await this.loadLocationNames(user.roleAssignments);
    const summary = this.toSummary(
      user,
      user.roleAssignments,
      locationNameById,
    );

    // Effective authorization, exactly as the guards resolve it. Unknown
    // stored permission keys are already dropped by AuthorizationService, so
    // they can never reach the presentation layer or the UI.
    const context = await this.authorizationService.loadContext(internalUserId);
    const capabilities = describeEffectiveCapabilities(
      context.summarize().capabilities,
    );

    return { ...summary, capabilities };
  }

  private async loadLocationNames(
    assignments: AssignmentRow[],
  ): Promise<Map<string, string>> {
    const locationIds = [
      ...new Set(
        assignments
          .filter((a) => a.scopeType === 'LOCATION' && a.scopeId)
          .map((a) => a.scopeId as string),
      ),
    ];
    if (locationIds.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.location.findMany({
      where: { id: { in: locationIds } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private toSummary(
    user: {
      id: string;
      displayName: string | null;
      email: string;
      status: AdminInternalUserSummary['status'];
    },
    assignments: AssignmentRow[],
    locationNameById: Map<string, string>,
  ): AdminInternalUserSummary {
    const accessLevels = [
      ...new Set(assignments.map((a) => a.role.displayName)),
    ].sort((a, b) => a.localeCompare(b));

    return {
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      status: user.status,
      accessLevels,
      locationAccess: resolveLocationAccess(assignments, locationNameById),
    };
  }
}

function resolveLocationAccess(
  assignments: AssignmentRow[],
  locationNameById: Map<string, string>,
): AdminUserLocationAccess {
  if (assignments.length === 0) {
    return { kind: 'none' };
  }
  // Any corporate assignment means the person operates everywhere — even if
  // they also hold narrower location assignments.
  if (
    assignments.some((a) => a.scopeType === 'CORPORATE' && a.scopeId === null)
  ) {
    return { kind: 'all' };
  }
  const ids = new Set<string>();
  for (const assignment of assignments) {
    if (
      assignment.scopeType === 'LOCATION' &&
      assignment.scopeId &&
      locationNameById.has(assignment.scopeId)
    ) {
      ids.add(assignment.scopeId);
    }
  }
  if (ids.size === 0) {
    return { kind: 'none' };
  }
  const locations = [...ids]
    .map((id) => ({ id, name: locationNameById.get(id) as string }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { kind: 'selected', locations };
}

function compareSummaries(
  a: AdminInternalUserSummary,
  b: AdminInternalUserSummary,
): number {
  const aKey = (a.displayName ?? a.email).toLowerCase();
  const bKey = (b.displayName ?? b.email).toLowerCase();
  return (
    aKey.localeCompare(bKey) ||
    a.email.toLowerCase().localeCompare(b.email.toLowerCase()) ||
    a.id.localeCompare(b.id)
  );
}
