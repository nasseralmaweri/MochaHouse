import { Prisma } from '@mocha-house/database';

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

// Milestone 8J — a plain, permission-agnostic primitive any domain module
// can call directly (mirrors isMediaAssetReferenced's "not a gated
// service" shape), never the full ApprovalsAdminService (whose
// approvals.* permissions a mere marketing.manage caller shouldn't need).
// The caller's own service is responsible for its own authorization check
// (e.g. marketing.manage) before calling this.
//
// Idempotent: reuses an already-PENDING request for the same
// (targetType, targetId, action) rather than creating a duplicate. The
// database's partial unique index (see the ApprovalRequest migration) is
// the real guarantee under concurrency; the P2002 catch here is the
// structural race-loser path, the same idiom as
// CheckoutService.createPaymentAttempt.
export async function createOrReusePendingApprovalRequest(
  tx: Prisma.TransactionClient,
  input: {
    targetType: string;
    targetId: string;
    action: string;
    requestedByInternalUserId: string;
  },
): Promise<{ request: Prisma.ApprovalRequestGetPayload<object>; created: boolean }> {
  const existing = await tx.approvalRequest.findFirst({
    where: {
      targetType: input.targetType,
      targetId: input.targetId,
      action: input.action,
      status: 'PENDING',
    },
  });
  if (existing) {
    return { request: existing, created: false };
  }

  try {
    const created = await tx.approvalRequest.create({
      data: {
        targetType: input.targetType,
        targetId: input.targetId,
        action: input.action,
        requestedByInternalUserId: input.requestedByInternalUserId,
      },
    });
    return { request: created, created: true };
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      const winner = await tx.approvalRequest.findFirstOrThrow({
        where: {
          targetType: input.targetType,
          targetId: input.targetId,
          action: input.action,
          status: 'PENDING',
        },
      });
      return { request: winner, created: false };
    }
    throw error;
  }
}

// The latest ApprovalRequest for a target+action, or null. Used by a
// domain service (e.g. CampaignsAdminService) to derive its own approval
// state for display and for the activation precondition — never exposed
// directly as an API response.
export async function latestApprovalRequest(
  tx: Prisma.TransactionClient,
  targetType: string,
  targetId: string,
  action: string,
): Promise<Prisma.ApprovalRequestGetPayload<object> | null> {
  return tx.approvalRequest.findFirst({
    where: { targetType, targetId, action },
    orderBy: { createdAt: 'desc' },
  });
}
