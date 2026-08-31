import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminAccessAssignmentOptions,
  AdminAssignableAccessLevel,
  AdminAssignInternalUserRoleRequest,
  AdminInternalUserAccessAssignment,
  AdminInternalUserDetail,
  AdminInternalUserSummary,
  AdminRemoveInternalUserRoleAssignmentRequest,
  AdminUpdateInternalUserStatusRequest,
  AdminUserLocationAccess,
  InternalUserStatus,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthorizationService } from '../../internal-auth/authorization/authorization.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import {
  isKnownPermissionKey,
  type InternalPermissionKey,
} from '../../internal-auth/authorization/permission-catalog';
import { InternalAuditService } from '../../audit/internal-audit.service';
import {
  describeAccessLevelCapabilities,
  describeEffectiveCapabilities,
} from './capability-presentation';
import {
  checkStatusTransition,
  removesActiveAccess,
} from './internal-user-status-transition';
import {
  protectedAdminWhere,
  assignmentCarriesProtectedAdminCapability,
} from './protected-admin';
import {
  actorCanGrant,
  resolveAssignmentShape,
  ASSIGNABLE_BUILT_IN_ROLE_KEYS,
} from './access-assignment-policy';

type AssignmentRow = {
  scopeType: 'CORPORATE' | 'LOCATION';
  scopeId: string | null;
  role: { displayName: string };
};

const REASON_MAX_LENGTH = 1000;

type AssignmentScope =
  { kind: 'corporate' } | { kind: 'locations'; locationIds: string[] };

// Admin view of internal users: read (Milestone 5E-1) and status management
// (Milestone 5E-3). Guarded by InternalAuthGuard + PermissionGuard at the
// controller; each method re-asserts the corporate permission it needs.
//
// This is NOT a second authorization engine: the "What they can do" list and
// the last-administrator check both come from the SAME permission + scope
// data AuthorizationService uses. Role display names are labels only.
@Injectable()
export class AdminInternalUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorizationService: AuthorizationService,
    private readonly audit: InternalAuditService,
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
    return this.buildUserDetail(internalUserId);
  }

  // --- Status management (Milestone 5E-3) -------------------------
  // A highly privileged, audited write. `users.manage_status` is
  // CORPORATE-only, so PermissionGuard already rejects a LOCATION grant;
  // `assertCorporate` here is the matching service-layer defense.
  //
  // The order matters: reject self-management and validate the request
  // shape OUTSIDE the transaction (cheap, no locks); then do the
  // existence re-check, the transition check, the last-administrator
  // check, the status update and the audit insert ALL inside one
  // Serializable transaction so they cannot be split by a concurrent
  // write.
  async updateStatus(
    internalUserId: string,
    request: AdminUpdateInternalUserStatusRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminInternalUserDetail> {
    authorization.assertCorporate('users.manage_status');

    if (internalUserId === actorInternalUserId) {
      throw new ForbiddenException('You can’t change your own status.');
    }

    const reason = this.validateReason(request?.reason);
    // Raw value from the request body — validated against the settable set
    // by checkStatusTransition below, so an unknown/INVITED value is a 400.
    const requestedStatus = String(request?.status) as InternalUserStatus;

    await this.prisma.$transaction(
      async (tx) => {
        const target = await tx.internalUser.findUnique({
          where: { id: internalUserId },
          select: { id: true, status: true },
        });
        if (!target) {
          throw new NotFoundException('Internal user not found.');
        }

        const transition = checkStatusTransition(
          target.status,
          requestedStatus,
        );
        if (!transition.ok) {
          throw transition.kind === 'no-op'
            ? new ConflictException(transition.message)
            : new BadRequestException(transition.message);
        }
        // checkStatusTransition({ ok: true }) guarantees this is a real,
        // settable status (ACTIVE / SUSPENDED / DISABLED).
        const nextStatus = requestedStatus;

        if (removesActiveAccess(target.status, nextStatus)) {
          // Protected-administrator definition is shared with the 5E-4
          // assignment-removal path (see protected-admin.ts): ACTIVE and
          // holding BOTH users.manage_status AND users.manage_roles at
          // CORPORATE. Milestone 5E-3 originally checked only
          // users.manage_status; unifying the two paths tightened this, but
          // the only shipped role granting either key grants both.
          const protectedAdmin = protectedAdminWhere();
          const targetIsProtectedAdmin =
            (await tx.internalUser.count({
              where: { id: target.id, ...protectedAdmin },
            })) > 0;

          if (targetIsProtectedAdmin) {
            // Require an INDEPENDENT administrator to remain — one who is
            // neither the target nor the acting administrator. The actor is
            // excluded deliberately: an administrator must not be able to
            // demote another administrator down to where the actor is the
            // sole remaining point of administrative control. This is
            // stricter than "never reach zero admins" and is what keeps a
            // spare in place after every demotion.
            const independentProtectedAdmins = await tx.internalUser.count({
              where: {
                id: { notIn: [target.id, actorInternalUserId] },
                ...protectedAdmin,
              },
            });
            if (independentProtectedAdmins === 0) {
              throw new ConflictException(
                'At least one other active Platform Administrator is required before this person can be suspended or disabled.',
              );
            }
          }
        }

        await tx.internalUser.update({
          where: { id: target.id },
          data: { status: nextStatus },
        });

        // Same transaction — the status change and its audit record commit
        // or roll back together.
        await this.audit.recordUserStatusChanged(tx, {
          actorInternalUserId,
          targetInternalUserId: target.id,
          before: target.status,
          after: nextStatus,
          reason,
        });
      },
      { isolationLevel: 'Serializable' },
    );

    return this.buildUserDetail(internalUserId);
  }

  // --- Access assignment (Milestone 5E-4) ------------------------
  // The picker data for granting access. Gated by `users.manage_roles`
  // (CORPORATE-only) — holding it is sufficient; `roles.view` is NOT
  // additionally required. Returns only the built-in access levels (there
  // is no custom-role editing) and the ACTIVE locations. `assignmentShape`
  // is derived from the level's own capabilities and a fixed policy for the
  // built-in keys — never from a role name as an authorization input.
  async getAccessOptions(
    authorization: AuthorizationContext,
  ): Promise<AdminAccessAssignmentOptions> {
    authorization.assertCorporate('users.manage_roles');

    const [roles, locations] = await Promise.all([
      this.prisma.internalRole.findMany({
        where: { key: { in: ASSIGNABLE_BUILT_IN_ROLE_KEYS } },
        select: {
          id: true,
          key: true,
          displayName: true,
          description: true,
          isSystem: true,
          permissions: { select: { permissionKey: true } },
        },
      }),
      this.prisma.location.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const accessLevels: AdminAssignableAccessLevel[] = roles
      .map((role) => {
        const permissionKeys = role.permissions.map((p) => p.permissionKey);
        const assignmentShape = resolveAssignmentShape({
          key: role.key,
          permissionKeys,
        });
        if (!assignmentShape) {
          return null;
        }
        const knownKeys = new Set<InternalPermissionKey>(
          permissionKeys.filter(isKnownPermissionKey),
        );
        return {
          id: role.id,
          displayName: role.displayName,
          description: role.description,
          isBuiltIn: role.isSystem,
          assignmentShape,
          capabilities: describeAccessLevelCapabilities(knownKeys),
        } satisfies AdminAssignableAccessLevel;
      })
      .filter((level): level is AdminAssignableAccessLevel => level !== null)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    return { accessLevels, locations };
  }

  // Grant an access level. `users.manage_roles` is CORPORATE-only, so
  // PermissionGuard already rejects a LOCATION grant; `assertCorporate` is
  // the matching service-layer defense.
  //
  // Cheap checks (self-target, request shape) run outside the transaction.
  // Everything that must be consistent — existence, the unknown-permission
  // fail-closed check, the assignment-policy check, location validation,
  // the privilege ceiling, de-duplication, the inserts and their audit
  // rows — runs inside ONE Serializable transaction.
  async assignRole(
    internalUserId: string,
    request: AdminAssignInternalUserRoleRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminInternalUserDetail> {
    authorization.assertCorporate('users.manage_roles');

    if (internalUserId === actorInternalUserId) {
      throw new ForbiddenException('You can’t change your own access.');
    }

    const reason = this.validateReason(request?.reason);
    const roleId =
      typeof request?.roleId === 'string' ? request.roleId.trim() : '';
    if (!roleId) {
      throw new BadRequestException('Choose an access level.');
    }
    const scope = parseAssignmentScope(request?.scope);

    await this.prisma.$transaction(
      async (tx) => {
        const target = await tx.internalUser.findUnique({
          where: { id: internalUserId },
          select: { id: true },
        });
        if (!target) {
          throw new NotFoundException('Internal user not found.');
        }

        const role = await tx.internalRole.findUnique({
          where: { id: roleId },
          select: {
            id: true,
            key: true,
            displayName: true,
            permissions: { select: { permissionKey: true } },
          },
        });
        if (!role) {
          throw new NotFoundException('Access level not found.');
        }

        const permissionKeys = role.permissions.map((p) => p.permissionKey);
        const unknownKeys = permissionKeys.filter(
          (key) => !isKnownPermissionKey(key),
        );
        if (unknownKeys.length > 0) {
          // Fail closed: an access level with a capability the code no
          // longer recognises cannot be assigned until it is corrected.
          throw new ConflictException(
            'This access level includes an unrecognised capability and can’t be assigned until it is corrected.',
          );
        }
        const knownKeys = permissionKeys as InternalPermissionKey[];

        const assignmentShape = resolveAssignmentShape({
          key: role.key,
          permissionKeys,
        });
        if (!assignmentShape) {
          throw new ConflictException('This access level can’t be assigned.');
        }
        if (
          assignmentShape === 'corporate-only' &&
          scope.kind !== 'corporate'
        ) {
          throw new BadRequestException(
            'This access level applies to every location and can’t be limited to specific ones.',
          );
        }
        if (assignmentShape === 'location-only' && scope.kind !== 'locations') {
          throw new BadRequestException(
            'Choose the locations this access level should apply to.',
          );
        }

        let locations: { id: string; name: string }[] = [];
        if (scope.kind === 'locations') {
          const ids = [...new Set(scope.locationIds)];
          if (ids.length === 0) {
            throw new BadRequestException('Choose at least one location.');
          }
          const rows = await tx.location.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true, isActive: true },
          });
          if (rows.length !== ids.length) {
            throw new BadRequestException(
              'One or more of the chosen locations no longer exists.',
            );
          }
          if (rows.some((row) => !row.isActive)) {
            // An assignment to an inactive location would contribute nothing
            // effective (the /internal/me summary intersects with active
            // locations), so it is rejected rather than silently stored.
            throw new BadRequestException(
              'One or more of the chosen locations is inactive.',
            );
          }
          locations = rows.map((row) => ({ id: row.id, name: row.name }));
        }

        const ceilingTarget =
          scope.kind === 'corporate'
            ? ({ kind: 'corporate' } as const)
            : ({
                kind: 'locations',
                locationIds: locations.map((l) => l.id),
              } as const);
        if (!actorCanGrant(authorization, knownKeys, ceilingTarget)) {
          throw new ForbiddenException(
            'You can’t grant an access level that includes access you don’t hold yourself.',
          );
        }

        const desired =
          scope.kind === 'corporate'
            ? [
                {
                  scopeType: 'CORPORATE' as const,
                  scopeId: null as string | null,
                  locationName: null as string | null,
                },
              ]
            : locations.map((location) => ({
                scopeType: 'LOCATION' as const,
                scopeId: location.id,
                locationName: location.name,
              }));

        const existing = await tx.internalUserRoleAssignment.findMany({
          where: { internalUserId: target.id, roleId: role.id },
          select: { scopeType: true, scopeId: true },
        });
        const existingKeys = new Set(
          existing.map((row) => `${row.scopeType}:${row.scopeId ?? ''}`),
        );
        const toCreate = desired.filter(
          (row) => !existingKeys.has(`${row.scopeType}:${row.scopeId ?? ''}`),
        );

        if (toCreate.length === 0) {
          // Deterministic duplicate handling: nothing new to create.
          throw new ConflictException(
            scope.kind === 'corporate'
              ? 'This person already has that access.'
              : 'This person already has that access for the chosen location(s).',
          );
        }
        // Mixed new / existing: create only the missing rows, silently
        // skipping the ones already present.

        for (const row of toCreate) {
          await tx.internalUserRoleAssignment.create({
            data: {
              internalUserId: target.id,
              roleId: role.id,
              scopeType: row.scopeType,
              scopeId: row.scopeId,
            },
          });
          await this.audit.recordRoleAssigned(tx, {
            actorInternalUserId,
            targetInternalUserId: target.id,
            roleId: role.id,
            roleDisplayName: role.displayName,
            scope: row.scopeType,
            locationId: row.scopeId,
            locationName: row.locationName,
            reason,
          });
        }
      },
      { isolationLevel: 'Serializable' },
    );

    return this.buildUserDetail(internalUserId);
  }

  // Remove ONE concrete access grant. Never removes more than the single
  // assignment addressed by `assignmentId`; removing one location's grant
  // leaves the person's other locations untouched.
  async removeRoleAssignment(
    internalUserId: string,
    assignmentId: string,
    request: AdminRemoveInternalUserRoleAssignmentRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminInternalUserDetail> {
    authorization.assertCorporate('users.manage_roles');

    if (internalUserId === actorInternalUserId) {
      throw new ForbiddenException('You can’t change your own access.');
    }

    const reason = this.validateReason(request?.reason);

    await this.prisma.$transaction(
      async (tx) => {
        const assignment = await tx.internalUserRoleAssignment.findUnique({
          where: { id: assignmentId },
          select: {
            id: true,
            internalUserId: true,
            scopeType: true,
            scopeId: true,
            role: {
              select: {
                id: true,
                displayName: true,
                permissions: { select: { permissionKey: true } },
              },
            },
          },
        });
        if (!assignment || assignment.internalUserId !== internalUserId) {
          throw new NotFoundException('Access assignment not found.');
        }

        let locationName: string | null = null;
        if (assignment.scopeType === 'LOCATION' && assignment.scopeId) {
          const location = await tx.location.findUnique({
            where: { id: assignment.scopeId },
            select: { name: true },
          });
          locationName = location?.name ?? null;
        }

        const protectedAdmin = protectedAdminWhere();
        const removalStripsProtectedCapability =
          assignmentCarriesProtectedAdminCapability(assignment);
        const targetWasProtectedAdmin =
          removalStripsProtectedCapability &&
          (await tx.internalUser.count({
            where: { id: internalUserId, ...protectedAdmin },
          })) > 0;

        await tx.internalUserRoleAssignment.delete({
          where: { id: assignment.id },
        });

        if (targetWasProtectedAdmin) {
          // Re-check AFTER the delete (same transaction — a throw here rolls
          // it back). If the person is still a protected administrator
          // through some other corporate grant, the removal is fine.
          const targetStillProtectedAdmin =
            (await tx.internalUser.count({
              where: { id: internalUserId, ...protectedAdmin },
            })) > 0;
          if (!targetStillProtectedAdmin) {
            const independentProtectedAdmins = await tx.internalUser.count({
              where: {
                id: { notIn: [internalUserId, actorInternalUserId] },
                ...protectedAdmin,
              },
            });
            if (independentProtectedAdmins === 0) {
              throw new ConflictException(
                'At least one other active Platform Administrator is required before this access can be removed.',
              );
            }
          }
        }

        await this.audit.recordRoleRemoved(tx, {
          actorInternalUserId,
          targetInternalUserId: internalUserId,
          roleId: assignment.role.id,
          roleDisplayName: assignment.role.displayName,
          scope:
            assignment.scopeType === 'CORPORATE' ? 'CORPORATE' : 'LOCATION',
          locationId: assignment.scopeId,
          locationName,
          reason,
        });
      },
      { isolationLevel: 'Serializable' },
    );

    return this.buildUserDetail(internalUserId);
  }

  private validateReason(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new BadRequestException('A reason is required.');
    }
    const reason = raw.trim();
    if (reason.length > REASON_MAX_LENGTH) {
      throw new BadRequestException(
        `Reason is too long (maximum ${REASON_MAX_LENGTH} characters).`,
      );
    }
    return reason;
  }

  private async buildUserDetail(
    internalUserId: string,
  ): Promise<AdminInternalUserDetail> {
    const user = await this.prisma.internalUser.findUnique({
      where: { id: internalUserId },
      select: {
        id: true,
        displayName: true,
        email: true,
        status: true,
        roleAssignments: {
          select: {
            id: true,
            scopeType: true,
            scopeId: true,
            role: {
              select: { id: true, displayName: true, isSystem: true },
            },
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

    // The concrete, individually-removable grants (Milestone 5E-4). A
    // LOCATION row whose location no longer resolves is dropped, exactly as
    // resolveLocationAccess drops it — the UI never shows a grant it cannot
    // name.
    const assignments: AdminInternalUserAccessAssignment[] =
      user.roleAssignments
        .map((assignment) => {
          const isCorporate =
            assignment.scopeType === 'CORPORATE' && assignment.scopeId === null;
          const location =
            assignment.scopeType === 'LOCATION' &&
            assignment.scopeId &&
            locationNameById.has(assignment.scopeId)
              ? {
                  id: assignment.scopeId,
                  name: locationNameById.get(assignment.scopeId) as string,
                }
              : null;
          return {
            id: assignment.id,
            accessLevel: {
              id: assignment.role.id,
              displayName: assignment.role.displayName,
              isBuiltIn: assignment.role.isSystem,
            },
            location,
            isCorporate,
          };
        })
        .filter((assignment) => assignment.isCorporate || assignment.location)
        .sort(compareAssignments);

    return { ...summary, capabilities, assignments };
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

// Parse the untyped request `scope` into a validated shape. The frontend
// works in "corporate / selected locations" terms; anything else is a 400.
function parseAssignmentScope(raw: unknown): AssignmentScope {
  if (!raw || typeof raw !== 'object') {
    throw new BadRequestException('Choose where this access level applies.');
  }
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === 'corporate') {
    return { kind: 'corporate' };
  }
  if (kind === 'locations') {
    const locationIds = (raw as { locationIds?: unknown }).locationIds;
    if (
      !Array.isArray(locationIds) ||
      locationIds.some((id) => typeof id !== 'string' || id.trim().length === 0)
    ) {
      throw new BadRequestException('Choose at least one location.');
    }
    return {
      kind: 'locations',
      locationIds: (locationIds as string[]).map((id) => id.trim()),
    };
  }
  throw new BadRequestException('Choose where this access level applies.');
}

function compareAssignments(
  a: AdminInternalUserAccessAssignment,
  b: AdminInternalUserAccessAssignment,
): number {
  if (a.isCorporate !== b.isCorporate) {
    return a.isCorporate ? -1 : 1;
  }
  return (
    (a.location?.name ?? '').localeCompare(b.location?.name ?? '') ||
    a.id.localeCompare(b.id)
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
