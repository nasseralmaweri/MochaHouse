import type { Prisma } from '@mocha-house/database';
import type { ProviderInvoiceRecord } from '../provider/saas-billing-provider';

// SC3e-1 — the business's billing history (owner decision D1): an invoice as
// the billing provider LAST reported it, written only from a live provider
// read (a verified event's invoice, or the reconciliation sweep's list) and
// only for the subscription it belongs to — matched through OUR stored
// provider ids, never through anything the event claims. The provider stays
// authoritative for money: this never charges, refunds or credits anyone.
//
//   RECORDED   new, or changed since the stored read;
//   UNCHANGED  the same as stored;
//   STALE      read before the stored version (a delayed event): ignored;
//   NOT_OURS   not this subscription's invoice (or another mode): ignored;
//   CONFLICT   contradicts what was recorded (another subscription, a paid
//              or void invoice reported otherwise, a new number): nothing is
//              written — the caller opens a review case.
export type InvoiceRecordOutcome =
  'RECORDED' | 'UNCHANGED' | 'STALE' | 'NOT_OURS' | 'CONFLICT';

export const INVOICE_HISTORY_CONFLICT_CASE = 'INVOICE_HISTORY_CONFLICT';

type Tx = Prisma.TransactionClient;

// SC3e-2 (owner decision D6) — the provider subscriptions whose invoices
// belong to this subscription's history: its current one, and every one a
// completed restart Checkout of OURS replaced (recorded by us when the
// Checkout was created — never a value from a request or an event).
export async function ownedExternalSubscriptionIds(
  tx: Pick<Tx, 'billingCheckoutSession'>,
  subscription: { id: string; externalSubscriptionId: string | null },
): Promise<string[]> {
  const replaced = await tx.billingCheckoutSession.findMany({
    where: {
      subscriptionId: subscription.id,
      status: 'COMPLETED',
      replacesExternalSubscriptionId: { not: null },
    },
    select: { replacesExternalSubscriptionId: true },
  });
  return [
    ...new Set(
      [
        subscription.externalSubscriptionId,
        ...replaced.map((row) => row.replacesExternalSubscriptionId),
      ].filter((id): id is string => id !== null),
    ),
  ];
}

export async function recordInvoice(
  tx: Tx,
  subscription: {
    id: string;
    billingProvider: string | null;
    externalSubscriptionId: string | null;
    externalCustomerId: string | null;
  },
  record: ProviderInvoiceRecord,
  readAt: Date,
  livemode: boolean,
): Promise<InvoiceRecordOutcome> {
  if (
    subscription.billingProvider === null ||
    subscription.externalSubscriptionId === null ||
    subscription.externalCustomerId === null ||
    record.livemode !== livemode ||
    record.externalSubscriptionId === null ||
    record.externalCustomerId !== subscription.externalCustomerId ||
    !(await ownedExternalSubscriptionIds(tx, subscription)).includes(
      record.externalSubscriptionId,
    )
  ) {
    return 'NOT_OURS';
  }
  const fields = {
    number: record.number,
    status: record.status,
    billingReason: record.billingReason,
    currency: record.currency,
    totalMinorUnits: record.totalMinorUnits,
    amountDueMinorUnits: record.amountDueMinorUnits,
    amountPaidMinorUnits: record.amountPaidMinorUnits,
    amountRemainingMinorUnits: record.amountRemainingMinorUnits,
    postPaymentCreditMinorUnits: record.postPaymentCreditMinorUnits,
    prePaymentCreditMinorUnits: record.prePaymentCreditMinorUnits,
    balanceAppliedMinorUnits: record.balanceAppliedMinorUnits,
    periodStart: record.periodStart,
    periodEnd: record.periodEnd,
    paidAt: record.paidAt,
    // SC3f — written only when the read carried them (a known amount is
    // never cleared; the database refuses it too).
    ...(record.amounts ? record.amounts : {}),
    ...(record.attemptCount !== null
      ? { attemptCount: record.attemptCount }
      : {}),
  };
  const existing = await tx.billingInvoice.findUnique({
    where: {
      provider_externalInvoiceId: {
        provider: subscription.billingProvider,
        externalInvoiceId: record.externalInvoiceId,
      },
    },
  });
  if (!existing) {
    await tx.billingInvoice.create({
      data: {
        subscriptionId: subscription.id,
        provider: subscription.billingProvider,
        externalInvoiceId: record.externalInvoiceId,
        externalCustomerId: record.externalCustomerId,
        externalSubscriptionId: record.externalSubscriptionId,
        issuedAt: record.issuedAt,
        syncedAt: readAt,
        ...fields,
      },
    });
    return 'RECORDED';
  }
  // Another subscription's (or another issue of) this invoice: never ours
  // to write, whenever it was read.
  if (
    existing.subscriptionId !== subscription.id ||
    existing.issuedAt.getTime() !== record.issuedAt.getTime()
  ) {
    return 'CONFLICT';
  }
  // A read older than the stored one (a delayed delivery) says nothing new.
  if (existing.syncedAt.getTime() > readAt.getTime()) return 'STALE';
  if (
    (existing.number !== null && existing.number !== record.number) ||
    ((existing.status === 'paid' || existing.status === 'void') &&
      existing.status !== record.status)
  ) {
    return 'CONFLICT';
  }
  const same = (Object.keys(fields) as (keyof typeof fields)[]).every((key) => {
    const a = existing[key];
    const b = fields[key];
    return a instanceof Date || b instanceof Date
      ? (a as Date | null)?.getTime() === (b as Date | null)?.getTime()
      : a === b;
  });
  if (same) return 'UNCHANGED';
  await tx.billingInvoice.update({
    where: { id: existing.id },
    data: { ...fields, syncedAt: readAt },
  });
  return 'RECORDED';
}
