import { Injectable } from '@nestjs/common';
import { Prisma } from '@mocha-house/database';
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

  // Records a logged / cleared Opening Checklist management exception
  // (Milestone 6C). Waiving a standard opening requirement is a significant
  // management decision, so it is durable history — unlike routine task and
  // checklist Complete/Undo, which are NOT audited. Call with the SAME `tx`
  // that set / cleared the exception fields on the ChecklistInstanceItem.
  // `targetType` is 'checklist_instance_item' (a new polymorphic target —
  // the audit table has always been polymorphic by design); the Admin
  // Activity Log, which is scoped to administrative-access changes, ignores
  // non-`internal_user` targets.
  async recordChecklistExceptionLogged(
    tx: Prisma.TransactionClient,
    input: ChecklistExceptionAuditInput & { reason: string },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'operations.checklist_exception_logged',
        targetType: 'checklist_instance_item',
        targetId: input.checklistInstanceItemId,
        beforeData: { resolution: 'open' },
        afterData: {
          resolution: 'exception',
          reason: input.reason,
          ...checklistExceptionContext(input),
        },
        reason: input.reason,
      },
    });
  }

  // Records a completed manual HQ Mocha Bean adjustment (Milestone 7A).
  // Manually moving a customer's Bean balance is a sensitive HQ action, so
  // it is administrative history in addition to the authoritative
  // MochaBeanLedgerEntry the same transaction writes. Call with the SAME
  // `tx` that inserted the ledger entry and updated the balance.
  //
  // `targetType` is 'customer' (a new polymorphic target — the audit table
  // has always been polymorphic by design). The Admin Activity Log is
  // scoped to `internal_user` targets and ignores this, exactly as it
  // ignores the 6C `checklist_instance_item` events.
  async recordMochaBeansAdjusted(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      customerId: string;
      deltaBeans: number;
      balanceBefore: number;
      balanceAfter: number;
      reason: string;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'loyalty.beans_adjusted',
        targetType: 'customer',
        targetId: input.customerId,
        beforeData: { balance: input.balanceBefore },
        afterData: {
          balance: input.balanceAfter,
          delta: input.deltaBeans,
        },
        reason: input.reason,
      },
    });
  }

  // --- Milestone 7B, HQ loyalty configuration + Rewards Catalog -----
  // Sensitive HQ configuration changes. Like every method here, each writes
  // in the SAME transaction as the change it records. The reward /
  // configuration tables remain the source of truth — these events are the
  // "who changed what, when" administrative trail, not reward data.
  //
  // targetType is 'loyalty_configuration' / 'loyalty_reward' — new
  // polymorphic targets. The Admin Activity Log is scoped to
  // 'internal_user' targets and ignores these, exactly as it ignores the 6C
  // 'checklist_instance_item' and 7A 'customer' events.

  async recordLoyaltyEarningRateChanged(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      beforeRatePerDollar: number;
      afterRatePerDollar: number;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'loyalty.earning_rate_changed',
        targetType: 'loyalty_configuration',
        targetId: 'company',
        beforeData: { earningRatePerDollar: input.beforeRatePerDollar },
        afterData: { earningRatePerDollar: input.afterRatePerDollar },
        reason: `Standard earning rate changed from ${input.beforeRatePerDollar} to ${input.afterRatePerDollar} Mocha Beans per qualifying dollar.`,
      },
    });
  }

  async recordLoyaltyRewardCreated(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      rewardId: string;
      snapshot: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'loyalty.reward_created',
        targetType: 'loyalty_reward',
        targetId: input.rewardId,
        // No beforeData — the reward did not exist.
        afterData: input.snapshot,
        reason: 'Loyalty reward created.',
      },
    });
  }

  async recordLoyaltyRewardUpdated(
    tx: Prisma.TransactionClient,
    input: {
      actorInternalUserId: string;
      rewardId: string;
      change: 'updated' | 'activated' | 'deactivated';
      before: Prisma.InputJsonValue;
      after: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    const action =
      input.change === 'activated'
        ? 'loyalty.reward_activated'
        : input.change === 'deactivated'
          ? 'loyalty.reward_deactivated'
          : 'loyalty.reward_updated';
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action,
        targetType: 'loyalty_reward',
        targetId: input.rewardId,
        beforeData: input.before,
        afterData: input.after,
        reason:
          input.change === 'activated'
            ? 'Loyalty reward activated.'
            : input.change === 'deactivated'
              ? 'Loyalty reward deactivated.'
              : 'Loyalty reward updated.',
      },
    });
  }

  async recordChecklistExceptionCleared(
    tx: Prisma.TransactionClient,
    input: ChecklistExceptionAuditInput & { previousReason: string },
  ): Promise<void> {
    await tx.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorInternalUserId,
        action: 'operations.checklist_exception_cleared',
        targetType: 'checklist_instance_item',
        targetId: input.checklistInstanceItemId,
        beforeData: {
          resolution: 'exception',
          reason: input.previousReason,
          ...checklistExceptionContext(input),
        },
        afterData: { resolution: 'open' },
        // The audit `reason` column is required; the exception reason being
        // cleared is the relevant context.
        reason: input.previousReason,
      },
    });
  }
}

interface ChecklistExceptionAuditInput {
  actorInternalUserId: string;
  checklistInstanceItemId: string;
  checklistInstanceId: string;
  locationId: string;
  locationName: string;
  itemLabel: string;
}

function checklistExceptionContext(input: ChecklistExceptionAuditInput): {
  checklistInstanceId: string;
  location: { id: string; name: string };
  itemLabel: string;
} {
  return {
    checklistInstanceId: input.checklistInstanceId,
    location: { id: input.locationId, name: input.locationName },
    itemLabel: input.itemLabel,
  };
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
