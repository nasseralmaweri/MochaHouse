// V1 Sales Tax PR 2 — the built-in sales tax calculation. Pure and exact:
// every amount is a non-negative integer number of minor units, every rate
// an integer number of parts per million, and all arithmetic on them is
// integer arithmetic (BigInt where a product could exceed 2^53). No
// floating-point number ever touches money.
//
//   1. Each store-funded discount is allocated to the order's lines: a freed
//      unit to its own line; any other discount pro rata over the lines it
//      applied to (by what each line has left), whole cents by the largest
//      remainder, ties to the earlier line.
//   2. A line's taxable amount is its total minus its discount allocations.
//      Gift cards are payment, never a discount: they do not appear here.
//   3. Each tax component is computed ONCE for the order: its rate times the
//      taxable amount of the lines whose tax class it applies to, rounded
//      half up to a whole minor unit. That tax is then allocated back to
//      those lines (by taxable amount, largest remainder, ties to the earlier
//      line), so the lines always add up to the component exactly.
//
// The same inputs always give the same result, so the calculation can be
// repeated from a frozen checkout and compared exactly.

export const TAX_CALCULATION_VERSION = 1;
const PPM = 1_000_000n;

export type TaxDiscountKind = 'PROMOTION' | 'REWARD';
// Who pays for the discount. Only store-funded discounts reduce the taxable
// price here; nothing in CENTERIVO creates any other kind yet.
export type TaxDiscountFunding = 'STORE';

export interface TaxCalculationLine {
  // Position in the order (0, 1, ...).
  lineIndex: number;
  productId: string;
  lineTotal: number;
  taxClassId: string;
}

export interface TaxCalculationDiscount {
  kind: TaxDiscountKind;
  funding: TaxDiscountFunding;
  amount: number;
  // A freed unit: the whole amount on that line. Otherwise pro rata over
  // `eligibleLineIndices` (null = every line).
  allocation:
    | { type: 'LINE'; lineIndex: number }
    | { type: 'PRO_RATA'; eligibleLineIndices: number[] | null };
}

export interface TaxCalculationComponent {
  componentId: string;
  name: string;
  jurisdiction: string;
  ratePpm: number;
  taxClassIds: string[];
}

export interface TaxCalculationInput {
  currency: string;
  lines: TaxCalculationLine[];
  discounts: TaxCalculationDiscount[];
  components: TaxCalculationComponent[];
}

export interface TaxedLine {
  lineIndex: number;
  productId: string;
  taxClassId: string;
  lineTotal: number;
  // Per discount, in input order.
  discountAllocations: number[];
  taxableMinorUnits: number;
  // Per component, in input order.
  componentTax: number[];
  taxMinorUnits: number;
}

export interface TaxedComponent {
  componentId: string;
  name: string;
  jurisdiction: string;
  ratePpm: number;
  taxClassIds: string[];
  taxableMinorUnits: number;
  taxMinorUnits: number;
}

export interface TaxCalculationResult {
  calculationVersion: typeof TAX_CALCULATION_VERSION;
  currency: string;
  merchandiseSubtotal: number;
  discountMinorUnits: number;
  // Sum of every line's taxable amount (whether or not any tax applies).
  taxableMinorUnits: number;
  taxMinorUnits: number;
  discounts: {
    kind: TaxDiscountKind;
    funding: TaxDiscountFunding;
    amount: number;
  }[];
  components: TaxedComponent[];
  lines: TaxedLine[];
}

export class TaxCalculationError extends Error {
  constructor(reason: string) {
    super(`Sales tax could not be calculated (${reason}).`);
    this.name = 'TaxCalculationError';
  }
}

const isMinorUnits = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// Rounds amount * ratePpm / 1e6 half up (amounts are never negative).
export function roundHalfUpTax(amount: number, ratePpm: number): number {
  if (!isMinorUnits(amount) || !isMinorUnits(ratePpm)) {
    throw new TaxCalculationError('amount or rate');
  }
  const product = BigInt(amount) * BigInt(ratePpm);
  return Number((product * 2n + PPM) / (2n * PPM));
}

// Splits `amount` over `weights` in proportion, whole units only: each gets
// the floor of its exact share, and the units left over go one each to the
// largest remainders (ties: the earlier position). Sums to `amount` exactly.
export function allocateProRata(amount: number, weights: number[]): number[] {
  if (!isMinorUnits(amount) || !weights.every(isMinorUnits)) {
    throw new TaxCalculationError('allocation');
  }
  const total = weights.reduce((sum, w) => sum + BigInt(w), 0n);
  if (amount === 0) return weights.map(() => 0);
  if (total === 0n || BigInt(amount) > total) {
    throw new TaxCalculationError('allocation exceeds its base');
  }
  const shares = weights.map((w) => (BigInt(amount) * BigInt(w)) / total);
  const remainders = weights.map((w, i) => ({
    i,
    r: (BigInt(amount) * BigInt(w)) % total,
  }));
  let left = BigInt(amount) - shares.reduce((sum, s) => sum + s, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (left === 0n) break;
    if (weights[i] === 0) continue;
    shares[i] += 1n;
    left -= 1n;
  }
  return shares.map(Number);
}

export function calculateSalesTax(
  input: TaxCalculationInput,
): TaxCalculationResult {
  const { lines, discounts, components } = input;
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new TaxCalculationError('currency');
  }
  if (lines.length === 0) throw new TaxCalculationError('no lines');
  lines.forEach((line, i) => {
    if (
      line.lineIndex !== i ||
      !isMinorUnits(line.lineTotal) ||
      typeof line.taxClassId !== 'string' ||
      line.taxClassId.length === 0
    ) {
      throw new TaxCalculationError('line');
    }
  });
  for (const component of components) {
    if (
      !Number.isSafeInteger(component.ratePpm) ||
      component.ratePpm < 1 ||
      component.ratePpm > 250_000 ||
      component.taxClassIds.length === 0
    ) {
      throw new TaxCalculationError('tax component');
    }
  }

  // 1. Discounts, in order, against what each line has left.
  const remaining = lines.map((line) => line.lineTotal);
  const allocations = lines.map(() => discounts.map(() => 0));
  discounts.forEach((discount, d) => {
    if (!isMinorUnits(discount.amount) || discount.funding !== 'STORE') {
      throw new TaxCalculationError('discount');
    }
    if (discount.amount === 0) return;
    if (discount.allocation.type === 'LINE') {
      const i = discount.allocation.lineIndex;
      if (
        !Number.isInteger(i) ||
        i < 0 ||
        i >= lines.length ||
        discount.amount > remaining[i]
      ) {
        throw new TaxCalculationError('discount line');
      }
      allocations[i][d] = discount.amount;
      remaining[i] -= discount.amount;
      return;
    }
    const eligible =
      discount.allocation.eligibleLineIndices ?? lines.map((_, i) => i);
    if (
      eligible.length === 0 ||
      eligible.some((i) => !Number.isInteger(i) || i < 0 || i >= lines.length)
    ) {
      throw new TaxCalculationError('discount lines');
    }
    const unique = [...new Set(eligible)].sort((a, b) => a - b);
    const shares = allocateProRata(
      discount.amount,
      unique.map((i) => remaining[i]),
    );
    unique.forEach((i, k) => {
      allocations[i][d] = shares[k];
      remaining[i] -= shares[k];
    });
  });

  // 2–3. Each component once for the order, then back to its lines.
  const componentTax = lines.map(() => components.map(() => 0));
  const taxedComponents: TaxedComponent[] = components.map((component, c) => {
    const classes = new Set(component.taxClassIds);
    const applies = lines
      .map((line, i) => i)
      .filter((i) => classes.has(lines[i].taxClassId));
    const base = applies.reduce((sum, i) => sum + remaining[i], 0);
    const tax = roundHalfUpTax(base, component.ratePpm);
    if (tax > 0) {
      const shares = allocateProRata(
        tax,
        applies.map((i) => remaining[i]),
      );
      applies.forEach((i, k) => {
        componentTax[i][c] = shares[k];
      });
    }
    return {
      componentId: component.componentId,
      name: component.name,
      jurisdiction: component.jurisdiction,
      ratePpm: component.ratePpm,
      taxClassIds: [...component.taxClassIds],
      taxableMinorUnits: base,
      taxMinorUnits: tax,
    };
  });

  const taxedLines: TaxedLine[] = lines.map((line, i) => ({
    lineIndex: i,
    productId: line.productId,
    taxClassId: line.taxClassId,
    lineTotal: line.lineTotal,
    discountAllocations: allocations[i],
    taxableMinorUnits: remaining[i],
    componentTax: componentTax[i],
    taxMinorUnits: componentTax[i].reduce((sum, t) => sum + t, 0),
  }));

  const result: TaxCalculationResult = {
    calculationVersion: TAX_CALCULATION_VERSION,
    currency: input.currency,
    merchandiseSubtotal: lines.reduce((sum, l) => sum + l.lineTotal, 0),
    discountMinorUnits: discounts.reduce((sum, d) => sum + d.amount, 0),
    taxableMinorUnits: remaining.reduce((sum, r) => sum + r, 0),
    taxMinorUnits: taxedComponents.reduce((sum, c) => sum + c.taxMinorUnits, 0),
    discounts: discounts.map((d) => ({
      kind: d.kind,
      funding: d.funding,
      amount: d.amount,
    })),
    components: taxedComponents,
    lines: taxedLines,
  };
  assertTaxResultReconciles(result);
  return result;
}

// Every total agrees with its parts, exactly. Used on every calculation and
// on every frozen calculation read back before an order is created.
export function assertTaxResultReconciles(result: TaxCalculationResult): void {
  const fail = (reason: string): never => {
    throw new TaxCalculationError(`does not reconcile: ${reason}`);
  };
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const all = [
    result.merchandiseSubtotal,
    result.discountMinorUnits,
    result.taxableMinorUnits,
    result.taxMinorUnits,
  ];
  if (!all.every(isMinorUnits)) fail('amounts');
  if (
    sum(result.lines.map((l) => l.lineTotal)) !== result.merchandiseSubtotal
  ) {
    fail('subtotal');
  }
  if (
    sum(result.discounts.map((d) => d.amount)) !== result.discountMinorUnits
  ) {
    fail('discounts');
  }
  result.discounts.forEach((d, k) => {
    if (
      sum(result.lines.map((l) => l.discountAllocations[k] ?? -1)) !== d.amount
    ) {
      fail('discount allocation');
    }
  });
  for (const line of result.lines) {
    if (
      line.discountAllocations.length !== result.discounts.length ||
      line.componentTax.length !== result.components.length ||
      !line.discountAllocations.every(isMinorUnits) ||
      !line.componentTax.every(isMinorUnits) ||
      line.lineTotal - sum(line.discountAllocations) !==
        line.taxableMinorUnits ||
      line.taxableMinorUnits < 0 ||
      sum(line.componentTax) !== line.taxMinorUnits
    ) {
      fail('line');
    }
  }
  if (
    sum(result.lines.map((l) => l.taxableMinorUnits)) !==
      result.taxableMinorUnits ||
    result.merchandiseSubtotal - result.discountMinorUnits !==
      result.taxableMinorUnits
  ) {
    fail('taxable');
  }
  result.components.forEach((component, c) => {
    const classes = new Set(component.taxClassIds);
    const applies = result.lines.filter((l) => classes.has(l.taxClassId));
    if (
      sum(applies.map((l) => l.taxableMinorUnits)) !==
        component.taxableMinorUnits ||
      roundHalfUpTax(component.taxableMinorUnits, component.ratePpm) !==
        component.taxMinorUnits ||
      sum(result.lines.map((l) => l.componentTax[c])) !==
        component.taxMinorUnits ||
      result.lines.some(
        (l) => !classes.has(l.taxClassId) && l.componentTax[c] !== 0,
      )
    ) {
      fail('component');
    }
  });
  if (
    sum(result.components.map((c) => c.taxMinorUnits)) !==
      result.taxMinorUnits ||
    sum(result.lines.map((l) => l.taxMinorUnits)) !== result.taxMinorUnits
  ) {
    fail('tax total');
  }
}
