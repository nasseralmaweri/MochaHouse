import type { Prisma } from '@mocha-house/database';

// R1 / S5b — the last check before a READY notice is sent: inside the SAME
// transaction that records the send intent, read the order's status under a
// FOR SHARE row lock. The closure writer takes FOR UPDATE on the same row, so
// the two serialise:
//   - closure first: this sees REJECTED / CANCELLED and the send never starts;
//   - intent first: the closure waits for it, and the notice (already begun
//     while the order was still READY) goes out — the one remaining window is a
//     cancellation committed after the send started, which is genuinely
//     concurrent and cannot be recalled.
// Only `order.status.ready` is checked; every other event returns false.
export async function orderClosedForReadyNotice(
  tx: Prisma.TransactionClient,
  event: { eventType: string; aggregateId: string; tenantId: string },
): Promise<boolean> {
  if (event.eventType !== 'order.status.ready') {
    return false;
  }
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status"::text AS "status" FROM "Order"
     WHERE "id" = ${event.aggregateId} AND "tenantId" = ${event.tenantId}
       FOR SHARE`;
  const status = rows[0]?.status;
  return status === 'REJECTED' || status === 'CANCELLED';
}
