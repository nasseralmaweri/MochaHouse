import { Injectable, NotFoundException } from '@nestjs/common';
import {
  INTERNAL_PERMISSION_KEYS,
  type AdminInternalUserDetail,
  type AdminInternalUserSummary,
  type AdminUserCapabilityGroup,
  type AdminUserLocationAccess,
  type InternalPermissionKey,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthorizationService } from '../../internal-auth/authorization/authorization.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';

// Plain-language wording for the "What they can do" list. Keyed by the
// closed permission vocabulary — NOT by role name. `corporate` wording is
// used when the person holds the permission for every location; `scoped`
// wording when they hold it only for specific locations. For the
// CORPORATE-only keys the two are identical (they can never be location-
// scoped). If a permission is ever added to the vocabulary without an entry
// here, the API build fails (Record is exhaustive) — a deliberate
// forcing-function so no capability ships without human wording.
const CAPABILITY_WORDING: Record<
  InternalPermissionKey,
  { group: string; corporate: string; scoped: string }
> = {
  'orders.view': {
    group: 'Orders',
    corporate: 'View orders at all locations',
    scoped: 'View orders at their locations',
  },
  'orders.manage_status': {
    group: 'Orders',
    corporate: 'Update order status at all locations',
    scoped: 'Update order status at their locations',
  },
  'catalog.view': {
    group: 'Menu & Products',
    corporate: 'View the full product catalogue',
    scoped: 'View the full product catalogue',
  },
  'catalog.products.edit': {
    group: 'Menu & Products',
    corporate: 'Edit standard product information',
    scoped: 'Edit standard product information',
  },
  'catalog.menu.manage': {
    group: 'Menu & Products',
    corporate: 'Manage which products are shown on menus',
    scoped: 'Manage which products are shown on menus',
  },
  'catalog.overrides.manage': {
    group: 'Menu & Products',
    corporate: 'Set prices and availability for all locations',
    scoped: 'Set prices and availability for their locations',
  },
  'locations.view': {
    group: 'Locations',
    corporate: 'View all locations',
    scoped: 'View their locations',
  },
  'locations.edit': {
    group: 'Locations',
    corporate: 'Edit location information',
    scoped: 'Edit location information',
  },
  'locations.manage_digital_ordering': {
    group: 'Locations',
    corporate: 'Turn online ordering on or off for all locations',
    scoped: 'Turn online ordering on or off for their locations',
  },
  'users.view': {
    group: 'Administration',
    corporate: 'View Admin users',
    scoped: 'View Admin users',
  },
};

const CAPABILITY_GROUP_ORDER = [
  'Orders',
  'Menu & Products',
  'Locations',
  'Administration',
];

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
      .map((user) => this.toSummary(user, user.roleAssignments, locationNameById))
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
    // they can never reach the wording map or the UI.
    const context =
      await this.authorizationService.loadContext(internalUserId);
    const capabilities = buildCapabilityGroups(context.summarize().capabilities);

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

function buildCapabilityGroups(
  capabilities: Partial<
    Record<InternalPermissionKey, { corporate: boolean; locationIds: string[] }>
  >,
): AdminUserCapabilityGroup[] {
  const itemsByGroup = new Map<string, string[]>();
  // Iterate the vocabulary (not Object.keys) so the order within a group is
  // deterministic regardless of grant order.
  for (const key of INTERNAL_PERMISSION_KEYS) {
    const capability = capabilities[key];
    if (!capability) {
      continue;
    }
    const wording = CAPABILITY_WORDING[key];
    const line = capability.corporate ? wording.corporate : wording.scoped;
    const list = itemsByGroup.get(wording.group) ?? [];
    list.push(line);
    itemsByGroup.set(wording.group, list);
  }
  return CAPABILITY_GROUP_ORDER.filter((group) => itemsByGroup.has(group)).map(
    (group) => ({ group, items: itemsByGroup.get(group) as string[] }),
  );
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
