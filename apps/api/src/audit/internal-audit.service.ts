import { Injectable } from '@nestjs/common';
import type { Prisma } from '@mocha-house/database';
import type { InternalUserStatus } from '@mocha-house/contracts';

// The write side of the access-control audit foundation (Milestone 5E-3).
// Small and structured on purpose: callers pass typed input, never SQL, and
// every write MUST run inside the same transaction as the change it records
// — the `tx` parameter is mandatory. Audit is durable application history,
// written synchronously; it is deliberately NOT an OutboxEvent.
@Injectable()
export class InternalAuditService {
  // Records a completed internal-user status change. Call this with the
  // SAME `tx` that performed the InternalUser.update, so the update and the
  // audit row commit or roll back together.
  async recordUserStatusChanged(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      targetInternalUserId: string;
      before: InternalUserStatus;
      after: InternalUserStatus;
      reason: string;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'user.status_changed',
        targetType: 'internal_user',
        targetId: input.targetInternalUserId,
        beforeData: { status: input.before },
        afterData: { status: input.after },
        reason: input.reason,
      },
    });
  }

  // Records a completed access-level assignment (Milestone 5E-4). Call with
  // the SAME `tx` that created the InternalUserRoleAssignment row. The event
  // snapshots the access level's display name and the location's name so
  // the record stays legible even if the role or location is later renamed
  // or removed. `beforeData` is the absence of the grant; `afterData` is
  // the grant.
  async recordRoleAssigned(
    tx: Prisma.TransactionClient,
    input: RoleAssignmentAuditInput,
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'user.role_assigned',
        targetType: 'internal_user',
        targetId: input.targetInternalUserId,
        beforeData: { assignment: null },
        afterData: { assignment: assignmentSnapshot(input) },
        reason: input.reason,
      },
    });
  }

  // Records a completed access-level removal (Milestone 5E-4) — the mirror
  // image of recordRoleAssigned. Call with the SAME `tx` that deleted the
  // InternalUserRoleAssignment row.
  async recordRoleRemoved(
    tx: Prisma.TransactionClient,
    input: RoleAssignmentAuditInput,
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'user.role_removed',
        targetType: 'internal_user',
        targetId: input.targetInternalUserId,
        beforeData: { assignment: assignmentSnapshot(input) },
        afterData: { assignment: null },
        reason: input.reason,
      },
    });
  }
}

interface RoleAssignmentAuditInput {
  actorInternalUserId: string;
  targetInternalUserId: string;
  roleId: string;
  roleDisplayName: string;
  scope: 'CORPORATE' | 'LOCATION';
  locationId?: string | null;
  locationName?: string | null;
  reason: string;
}

function assignmentSnapshot(input: RoleAssignmentAuditInput): {
  roleId: string;
  roleDisplayName: string;
  scope: 'CORPORATE' | 'LOCATION';
  locationId?: string;
  locationName?: string;
} {
  const snapshot: {
    roleId: string;
    roleDisplayName: string;
    scope: 'CORPORATE' | 'LOCATION';
    locationId?: string;
    locationName?: string;
  } = {
    roleId: input.roleId,
    roleDisplayName: input.roleDisplayName,
    scope: input.scope,
  };
  if (input.scope === 'LOCATION' && input.locationId) {
    snapshot.locationId = input.locationId;
    if (input.locationName) {
      snapshot.locationName = input.locationName;
    }
  }
  return snapshot;
}
