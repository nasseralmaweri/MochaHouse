// V1 Sales Tax PR 3 — what an item refund returns, from the order's ORIGINAL
// tax snapshot. Pure and exact (integers only; BigInt for products).
//
// For each refunded line, every amount (the line's net merchandise after its
// store-funded discounts, and its tax per component) is returned
// CUMULATIVELY: after k of the line's q units have been refunded in total,
// exactly floor(amount * k / q) of it has been returned — and all of it once
// every unit has. Each refund takes the difference from what earlier refunds
// of that line (still counting) already returned. So several partial refunds
// always add up to exactly the line's amounts, never more, and nothing is
// ever recalculated at today's rates.

export interface SnapshotTaxLine {
  lineIndex: number;
  quantity: number;
  // Net merchandise after store-funded discounts (the snapshot's taxable).
  merchandiseMinorUnits: number;
  // Tax per component, aligned with `componentKeys`.
  componentTax: number[];
}

// What earlier item refunds of a line (whose card refund still counts)
// returned.
export interface PriorLineRefund {
  quantity: number;
  merchandiseMinorUnits: number;
  componentTax: number[];
}

export interface RequestedRefundItem {
  lineIndex: number;
  quantity: number;
}

export interface AllocatedRefundLine {
  lineIndex: number;
  quantity: number;
  merchandiseMinorUnits: number;
  componentTax: number[];
  taxMinorUnits: number;
}

export interface ItemRefundAllocation {
  lines: AllocatedRefundLine[];
  merchandiseMinorUnits: number;
  // Per component, aligned with `componentKeys`.
  componentTax: number[];
  taxMinorUnits: number;
  totalMinorUnits: number;
}

export class ItemRefundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemRefundError';
  }
}

const isWhole = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

// floor(amount * k / q), exact.
function cumulative(amount: number, k: number, q: number): number {
  if (k >= q) return amount;
  return Number((BigInt(amount) * BigInt(k)) / BigInt(q));
}

export function allocateItemRefund(input: {
  componentKeys: string[];
  lines: SnapshotTaxLine[];
  prior: Map<number, PriorLineRefund>;
  items: RequestedRefundItem[];
}): ItemRefundAllocation {
  const { componentKeys, lines, prior, items } = input;
  if (items.length === 0) {
    throw new ItemRefundError('Choose at least one item to refund.');
  }
  const seen = new Set<number>();
  const allocated: AllocatedRefundLine[] = [];
  for (const item of items) {
    if (!Number.isInteger(item.lineIndex) || seen.has(item.lineIndex)) {
      throw new ItemRefundError('Each item can be chosen once.');
    }
    seen.add(item.lineIndex);
    const line = lines.find((l) => l.lineIndex === item.lineIndex);
    if (!line) throw new ItemRefundError('That item is not on this order.');
    if (
      !isWhole(line.quantity) ||
      line.quantity < 1 ||
      !isWhole(line.merchandiseMinorUnits) ||
      line.componentTax.length !== componentKeys.length ||
      !line.componentTax.every(isWhole)
    ) {
      throw new ItemRefundError("This order's tax record cannot be read.");
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new ItemRefundError('Choose a whole number of items to refund.');
    }
    const before = prior.get(item.lineIndex) ?? {
      quantity: 0,
      merchandiseMinorUnits: 0,
      componentTax: componentKeys.map(() => 0),
    };
    const after = before.quantity + item.quantity;
    if (after > line.quantity) {
      const left = line.quantity - before.quantity;
      throw new ItemRefundError(
        left <= 0
          ? 'Every unit of that item has already been refunded.'
          : `Only ${left} of that item can still be refunded.`,
      );
    }
    const take = (total: number, already: number, k: number) => {
      // Never below zero, never past what the line was charged.
      const target = cumulative(total, k, line.quantity);
      return Math.max(0, Math.min(target - already, total - already));
    };
    const merchandise = take(
      line.merchandiseMinorUnits,
      before.merchandiseMinorUnits,
      after,
    );
    const componentTax = line.componentTax.map((tax, c) =>
      take(tax, before.componentTax[c] ?? 0, after),
    );
    allocated.push({
      lineIndex: item.lineIndex,
      quantity: item.quantity,
      merchandiseMinorUnits: merchandise,
      componentTax,
      taxMinorUnits: componentTax.reduce((a, b) => a + b, 0),
    });
  }
  allocated.sort((a, b) => a.lineIndex - b.lineIndex);
  const merchandiseMinorUnits = allocated.reduce(
    (a, l) => a + l.merchandiseMinorUnits,
    0,
  );
  const componentTax = componentKeys.map((_, c) =>
    allocated.reduce((a, l) => a + l.componentTax[c], 0),
  );
  const taxMinorUnits = componentTax.reduce((a, b) => a + b, 0);
  return {
    lines: allocated,
    merchandiseMinorUnits,
    componentTax,
    taxMinorUnits,
    totalMinorUnits: merchandiseMinorUnits + taxMinorUnits,
  };
}
