import type { Prisma } from '@mocha-house/database';
import {
  obligationStanding,
  type PaymentRefundStatus,
  type RefundRow,
} from '../../payment/payment-refunds';

// ESP-04 M5b (shared since M5c by staff refunds and refund reconciliation) —
// an order's refund obligation follows its payment's refunds:
//   * REFUNDED (PROCESSOR, the latest succeeded refund's id) as soon as
//     verified refunds cover it and no returned refund is unreviewed — the
//     database checks all of it again;
//   * PROCESSING while a refund toward it is on its way, or part of it has
//     been refunded (the rest still to ask for);
//   * FAILED only when nothing of it has been refunded and nothing is on its
//     way (every attempt failed).
// A REFUNDED obligation never changes (S5a): what is owed after a late
// failure is calculated from the refunds. Runs inside the caller's
// transaction, after a refund of the payment changed.
export async function syncRefundObligation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  paymentAttemptId: string,
): Promise<void> {
  const obligation = await tx.orderRefundObligation.findFirst({
    where: { tenantId, paymentAttemptId },
    select: { id: true, amountMinorUnits: true, status: true },
  });
  if (!obligation || obligation.status === 'REFUNDED') return;
  const refunds = await tx.paymentRefund.findMany({
    where: { tenantId, paymentAttemptId },
    select: {
      status: true,
      amountMinorUnits: true,
      origin: true,
      succeededAt: true,
      lateFailureReviewedAt: true,
      providerRefundId: true,
    },
    orderBy: [{ succeededAt: 'desc' }, { createdAt: 'desc' }],
  });
  const standing = obligationStanding(
    obligation.amountMinorUnits,
    refunds.map(refundRowOf),
    obligation.status,
  );
  if (standing.settleable) {
    const settling = refunds.find((r) => r.status === 'SUCCEEDED');
    await tx.orderRefundObligation.updateMany({
      where: {
        id: obligation.id,
        tenantId,
        status: { in: ['DUE', 'PROCESSING', 'FAILED'] },
      },
      data: {
        status: 'REFUNDED',
        settlementMethod: 'PROCESSOR',
        processorRefundId: settling!.providerRefundId,
        settledAt: new Date(),
      },
    });
    return;
  }
  if (standing.inProgressMinorUnits > 0 || standing.refundedMinorUnits > 0) {
    if (obligation.status !== 'PROCESSING') {
      await tx.orderRefundObligation.updateMany({
        where: {
          id: obligation.id,
          tenantId,
          status: { in: ['DUE', 'FAILED'] },
        },
        data: { status: 'PROCESSING' },
      });
    }
    return;
  }
  if (obligation.status === 'PROCESSING') {
    await tx.orderRefundObligation.updateMany({
      where: { id: obligation.id, tenantId, status: 'PROCESSING' },
      data: { status: 'FAILED' },
    });
  }
}

export function refundRowOf(r: {
  status: string;
  amountMinorUnits: number;
  origin: string;
  succeededAt: Date | null;
  lateFailureReviewedAt: Date | null;
}): RefundRow {
  return {
    status: r.status as PaymentRefundStatus,
    amountMinorUnits: r.amountMinorUnits,
    origin: r.origin === 'EXTERNAL' ? 'EXTERNAL' : 'CENTERIVO',
    succeededAt: r.succeededAt,
    lateFailureReviewedAt: r.lateFailureReviewedAt,
  };
}
