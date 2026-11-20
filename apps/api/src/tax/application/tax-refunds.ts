import {
  formatTaxRatePpm,
  type OrderItemRefundLine,
  type OrderItemRefundPreview,
  type OrderRefundItemInput,
  type TaxJurisdiction,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  ItemRefundError,
  allocateItemRefund,
  type ItemRefundAllocation,
  type PriorLineRefund,
  type SnapshotTaxLine,
} from '../domain/tax-refund-allocation';

// V1 Sales Tax PR 3 — the tax an order's money coming back returns, always
// from the order's ORIGINAL tax snapshot. Item refunds of a completed order
// and cancellations of a taxed order write an immutable OrderTaxRefund;
// whether it counts as refunded is read from the money, never stored.

type Db = Prisma.TransactionClient | PrismaService;

// Card refund statuses whose money is (or may be) on its way back: their
// items stay taken. FAILED, CANCELED, NOT_CREATED and FAILED_AFTER_SUCCESS
// returned nothing to the customer, so their items can be refunded again.
export const LIVE_REFUND_STATUSES = [
  'REQUESTED',
  'PENDING',
  'UNKNOWN',
  'SUCCEEDED',
] as const;

export { ItemRefundError };

interface SnapshotComponent {
  key: string;
  name: string;
  jurisdiction: string;
  ratePpm: number;
}

export interface ItemRefundBasis {
  snapshotId: string;
  locationId: string;
  currency: string;
  components: SnapshotComponent[];
  lines: (SnapshotTaxLine & { productName: string })[];
  prior: Map<number, PriorLineRefund>;
}

interface SnapshotDetail {
  components?: {
    componentId?: unknown;
    name?: unknown;
    jurisdiction?: unknown;
    ratePpm?: unknown;
  }[];
  lines?: {
    lineIndex?: unknown;
    taxableMinorUnits?: unknown;
    componentTax?: unknown;
  }[];
}

const isWhole = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

// The order's snapshot and lines as item refunds see them, and what live item
// refunds already took. Null when the order has no tax snapshot (an order
// from before sales tax: amount refunds only). Throws ItemRefundError when
// the snapshot cannot be matched to the order's lines.
export async function itemRefundBasis(
  db: Db,
  tenantId: string,
  orderId: string,
): Promise<ItemRefundBasis | null> {
  const snapshot = await db.orderTaxSnapshot.findFirst({
    where: { tenantId, orderId },
    select: {
      id: true,
      currency: true,
      detail: true,
      order: { select: { locationId: true } },
    },
  });
  if (!snapshot) return null;
  const detail = snapshot.detail as unknown as SnapshotDetail;
  const unreadable = () =>
    new ItemRefundError(
      "This order's items cannot be matched to its tax record. Refund an amount instead.",
    );
  const components: SnapshotComponent[] = (detail.components ?? []).map((c) => {
    if (
      typeof c.componentId !== 'string' ||
      typeof c.name !== 'string' ||
      typeof c.jurisdiction !== 'string' ||
      !isWhole(c.ratePpm)
    ) {
      throw unreadable();
    }
    return {
      key: c.componentId,
      name: c.name,
      jurisdiction: c.jurisdiction,
      ratePpm: c.ratePpm,
    };
  });
  const orderLines = await db.orderLine.findMany({
    where: { tenantId, orderId },
    select: { lineIndex: true, quantity: true, productName: true },
  });
  const detailLines = detail.lines ?? [];
  if (
    orderLines.length === 0 ||
    orderLines.length !== detailLines.length ||
    orderLines.some((l) => l.lineIndex === null)
  ) {
    throw unreadable();
  }
  const lines = detailLines.map((d) => {
    const line = orderLines.find((l) => l.lineIndex === d.lineIndex);
    if (
      !line ||
      !isWhole(d.taxableMinorUnits) ||
      !Array.isArray(d.componentTax) ||
      d.componentTax.length !== components.length ||
      !d.componentTax.every(isWhole)
    ) {
      throw unreadable();
    }
    return {
      lineIndex: line.lineIndex!,
      quantity: line.quantity,
      productName: line.productName,
      merchandiseMinorUnits: d.taxableMinorUnits,
      componentTax: d.componentTax,
    };
  });

  const live = await db.orderTaxRefund.findMany({
    where: {
      tenantId,
      orderId,
      kind: 'ITEM',
      paymentRefund: { status: { in: [...LIVE_REFUND_STATUSES] } },
    },
    select: {
      lines: {
        select: {
          lineIndex: true,
          quantity: true,
          merchandiseMinorUnits: true,
        },
      },
      components: {
        select: { lineIndex: true, componentKey: true, taxMinorUnits: true },
      },
    },
  });
  const prior = new Map<number, PriorLineRefund>();
  for (const refund of live) {
    for (const l of refund.lines) {
      const p = prior.get(l.lineIndex) ?? {
        quantity: 0,
        merchandiseMinorUnits: 0,
        componentTax: components.map(() => 0),
      };
      p.quantity += l.quantity;
      p.merchandiseMinorUnits += l.merchandiseMinorUnits;
      prior.set(l.lineIndex, p);
    }
    for (const c of refund.components) {
      const p = prior.get(c.lineIndex);
      const k = components.findIndex((x) => x.key === c.componentKey);
      if (p && k >= 0) p.componentTax[k] += c.taxMinorUnits;
    }
  }
  return {
    snapshotId: snapshot.id,
    locationId: snapshot.order.locationId,
    currency: snapshot.currency,
    components,
    lines,
    prior,
  };
}

export function allocateFromBasis(
  basis: ItemRefundBasis,
  items: OrderRefundItemInput[],
): ItemRefundAllocation {
  return allocateItemRefund({
    componentKeys: basis.components.map((c) => c.key),
    lines: basis.lines,
    prior: basis.prior,
    items,
  });
}

export function itemRefundLinesOf(
  basis: ItemRefundBasis,
): OrderItemRefundLine[] {
  return basis.lines.map((line) => {
    const refunded = basis.prior.get(line.lineIndex)?.quantity ?? 0;
    return {
      lineIndex: line.lineIndex,
      productName: line.productName,
      quantity: line.quantity,
      refundedQuantity: refunded,
      remainingQuantity: Math.max(0, line.quantity - refunded),
      merchandiseMinorUnits: line.merchandiseMinorUnits,
      taxMinorUnits: line.componentTax.reduce((a, b) => a + b, 0),
    };
  });
}

export function previewOf(
  basis: ItemRefundBasis,
  allocation: ItemRefundAllocation,
): OrderItemRefundPreview {
  return {
    merchandiseMinorUnits: allocation.merchandiseMinorUnits,
    taxMinorUnits: allocation.taxMinorUnits,
    totalMinorUnits: allocation.totalMinorUnits,
    components: basis.components.map((c, k) => ({
      name: c.name,
      jurisdiction: c.jurisdiction as TaxJurisdiction,
      ratePercent: formatTaxRatePpm(c.ratePpm),
      taxableMinorUnits: 0,
      taxMinorUnits: allocation.componentTax[k],
    })),
    lines: allocation.lines.map((l) => ({
      lineIndex: l.lineIndex,
      productName:
        basis.lines.find((x) => x.lineIndex === l.lineIndex)?.productName ?? '',
      quantity: l.quantity,
      merchandiseMinorUnits: l.merchandiseMinorUnits,
      taxMinorUnits: l.taxMinorUnits,
    })),
  };
}

// Writes the item refund's tax record with its card refund (same
// transaction). The database checks it against the order, its card refund
// and its snapshot at commit.
export async function recordItemTaxRefund(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    orderId: string;
    paymentRefundId: string;
    actorId: string;
    basis: ItemRefundBasis;
    allocation: ItemRefundAllocation;
  },
): Promise<void> {
  const { basis, allocation, tenantId } = input;
  await tx.orderTaxRefund.create({
    data: {
      tenantId,
      orderId: input.orderId,
      locationId: basis.locationId,
      orderTaxSnapshotId: basis.snapshotId,
      kind: 'ITEM',
      paymentRefundId: input.paymentRefundId,
      currency: basis.currency,
      merchandiseMinorUnits: allocation.merchandiseMinorUnits,
      taxMinorUnits: allocation.taxMinorUnits,
      createdByInternalUserId: input.actorId,
      lines: {
        create: allocation.lines.map((l) => ({
          lineIndex: l.lineIndex,
          quantity: l.quantity,
          merchandiseMinorUnits: l.merchandiseMinorUnits,
          taxMinorUnits: l.taxMinorUnits,
        })),
      },
      components: {
        create: allocation.lines.flatMap((l) =>
          basis.components
            .map((c, k) => ({ c, tax: l.componentTax[k] }))
            .filter(({ tax }) => tax > 0)
            .map(({ c, tax }) => ({
              lineIndex: l.lineIndex,
              componentKey: c.key,
              name: c.name,
              jurisdiction: c.jurisdiction,
              ratePpm: c.ratePpm,
              taxMinorUnits: tax,
            })),
        ),
      },
    },
  });
}

// A rejected or cancelled taxed order returns its whole tax: every line in
// full, from its snapshot. Written in the closure's own transaction.
// Nothing for an order without a snapshot (before sales tax).
export async function recordClosureTaxRefund(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    orderId: string;
    orderClosureId: string;
    actorId: string;
  },
): Promise<void> {
  let basis: ItemRefundBasis | null;
  try {
    basis = await itemRefundBasis(tx, input.tenantId, input.orderId);
  } catch (error) {
    // A taxed order whose lines cannot be matched to its snapshot (created
    // before line positions existed): the closure is never blocked; no
    // record is written, and the sales tax report lists the cancellation as
    // unresolved instead of counting its tax either way.
    if (error instanceof ItemRefundError) return;
    throw error;
  }
  if (!basis) return;
  const allocation = allocateFromBasis(
    { ...basis, prior: new Map() },
    basis.lines.map((l) => ({ lineIndex: l.lineIndex, quantity: l.quantity })),
  );
  await tx.orderTaxRefund.create({
    data: {
      tenantId: input.tenantId,
      orderId: input.orderId,
      locationId: basis.locationId,
      orderTaxSnapshotId: basis.snapshotId,
      kind: 'CLOSURE',
      orderClosureId: input.orderClosureId,
      currency: basis.currency,
      merchandiseMinorUnits: allocation.merchandiseMinorUnits,
      taxMinorUnits: allocation.taxMinorUnits,
      createdByInternalUserId: input.actorId,
      lines: {
        create: allocation.lines.map((l) => ({
          lineIndex: l.lineIndex,
          quantity: l.quantity,
          merchandiseMinorUnits: l.merchandiseMinorUnits,
          taxMinorUnits: l.taxMinorUnits,
        })),
      },
      components: {
        create: allocation.lines.flatMap((l) =>
          basis.components
            .map((c, k) => ({ c, tax: l.componentTax[k] }))
            .filter(({ tax }) => tax > 0)
            .map(({ c, tax }) => ({
              lineIndex: l.lineIndex,
              componentKey: c.key,
              name: c.name,
              jurisdiction: c.jurisdiction,
              ratePpm: c.ratePpm,
              taxMinorUnits: tax,
            })),
        ),
      },
    },
  });
}

// Whether a tax refund counts. ITEM: by its card refund. CLOSURE: by its
// obligation — confirmed when nothing was card-paid, or when the card money
// is fully refunded (a settled obligation, or succeeded refunds covering it,
// with nothing returned since); otherwise pending.
export type TaxRefundStatus = 'CONFIRMED' | 'PENDING' | 'FAILED';

export function itemTaxRefundStatus(
  paymentRefundStatus: string,
): TaxRefundStatus {
  if (paymentRefundStatus === 'SUCCEEDED') return 'CONFIRMED';
  if (
    paymentRefundStatus === 'REQUESTED' ||
    paymentRefundStatus === 'PENDING' ||
    paymentRefundStatus === 'UNKNOWN'
  ) {
    return 'PENDING';
  }
  return 'FAILED';
}
