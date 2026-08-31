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
}
