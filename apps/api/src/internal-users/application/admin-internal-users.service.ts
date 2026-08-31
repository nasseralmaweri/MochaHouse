import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminInternalUserDetail,
  AdminInternalUserSummary,
  AdminUpdateInternalUserStatusRequest,
  AdminUserLocationAccess,
  InternalUserStatus,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthorizationService } from '../../internal-auth/authorization/authorization.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { InternalAuditService } from '../../audit/internal-audit.service';
import { describeEffectiveCapabilities } from './capability-presentation';
import {
  checkStatusTransition,
  removesActiveAccess,
} from './internal-user-status-transition';

type AssignmentRow = {
  scopeType: 'CORPORATE' | 'LOCATION';
  scopeId: string | null;
  role: { displayName: string };
};

const REASON_MAX_LENGTH = 1000;

// The `where` clause matching an ACTIVE internal user who EFFECTIVELY holds
// `users.manage_status` at CORPORATE scope — i.e. someone who can administer
// internal-user access. It mirrors AuthorizationService.toValidScopeGrant:
// only a well-formed CORPORATE assignment (scopeId IS NULL) counts, and only
// if the role actually stores the exact permission key. A LOCATION grant, a
// malformed CORPORATE-with-scopeId row, an unknown permission key, and a
// non-ACTIVE user all fail this filter — never a role display name.
const ACTIVE_CORPORATE_STATUS_ADMIN = {
  status: 'ACTIVE' as const,
  roleAssignments: {
    some: {
      scopeType: 'CORPORATE' as const,
      scopeId: null,
      role: {
        permissions: { some: { permissionKey: 'users.manage_status' } },
      },
    },
  },
};

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
          const targetIsProtectedAdmin =
            (await tx.internalUser.count({
              where: { id: target.id, ...ACTIVE_CORPORATE_STATUS_ADMIN },
            })) > 0;

          if (targetIsProtectedAdmin) {
            // Require an INDEPENDENT administrator to remain — one who is
            // neither the target nor the acting administrator. The actor is
            // excluded deliberately: an administrator must not be able to
            // demote another administrator down to where the actor is the
            // sole remaining point of administrative control. This is
            // stricter than "never reach zero admins" and is what keeps a
            // spare in place after every demotion.
            const independentProtectedAdmins =
              await tx.internalUser.count({
                where: {
                  id: { notIn: [target.id, actorInternalUserId] },
                  ...ACTIVE_CORPORATE_STATUS_ADMIN,
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
    const summary = this.toSummary(user, user.roleAssignments, locationNameById);

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
