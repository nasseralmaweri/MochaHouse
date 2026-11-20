import {
  TaxCalculationError,
  allocateProRata,
  assertTaxResultReconciles,
  calculateSalesTax,
  roundHalfUpTax,
  type TaxCalculationComponent,
  type TaxCalculationDiscount,
  type TaxCalculationLine,
} from './tax-calculation';

// V1 Sales Tax PR 2 — the pure, exact calculation.
const FOOD = 'class-food';
const GROCERY = 'class-grocery';
const EXEMPT = 'class-exempt';

const line = (
  lineIndex: number,
  lineTotal: number,
  taxClassId = FOOD,
): TaxCalculationLine => ({
  lineIndex,
  productId: `p${lineIndex}`,
  lineTotal,
  taxClassId,
});
const component = (
  ratePpm: number,
  taxClassIds: string[] = [FOOD],
  name = 'State',
): TaxCalculationComponent => ({
  componentId: `c-${name}`,
  name,
  jurisdiction: 'STATE',
  ratePpm,
  taxClassIds,
});
const proRata = (
  amount: number,
  eligibleLineIndices: number[] | null = null,
  kind: TaxCalculationDiscount['kind'] = 'PROMOTION',
): TaxCalculationDiscount => ({
  kind,
  funding: 'STORE',
  amount,
  allocation: { type: 'PRO_RATA', eligibleLineIndices },
});

describe('rounding and allocation primitives', () => {
  it.each([
    [1000, 60_000, 60], // $10.00 at 6% = $0.60
    [25, 60_000, 2], // 1.5 cents rounds half up
    [24, 60_000, 1], // 1.44 cents rounds down
    [8, 62_500, 1], // 0.5 cents rounds half up
    [7, 62_500, 0], // 0.4375 cents rounds down
    [1, 1, 0],
    [0, 250_000, 0],
    // Far beyond 2^53 / 1e6: exact with BigInt.
    [9_000_000_000_000, 250_000, 2_250_000_000_000],
  ])('%p at %p ppm is %p', (amount, rate, tax) => {
    expect(roundHalfUpTax(amount, rate)).toBe(tax);
  });

  it('allocates whole units by largest remainder, ties to the earlier line', () => {
    expect(allocateProRata(10, [6, 6, 6])).toEqual([4, 3, 3]);
    expect(allocateProRata(2, [1, 1, 1])).toEqual([1, 1, 0]);
    expect(allocateProRata(100, [50, 30, 20])).toEqual([50, 30, 20]);
    expect(allocateProRata(5, [0, 3, 3])).toEqual([0, 3, 2]);
    expect(allocateProRata(0, [5, 5])).toEqual([0, 0]);
    expect(() => allocateProRata(11, [5, 5])).toThrow(TaxCalculationError);
    expect(() => allocateProRata(1, [0, 0])).toThrow(TaxCalculationError);
    expect(() => allocateProRata(1.5, [5])).toThrow(TaxCalculationError);
  });
});

describe('calculateSalesTax', () => {
  it('taxes every line of a covered class once for the order', () => {
    const result = calculateSalesTax({
      currency: 'USD',
      lines: [line(0, 450), line(1, 325)],
      discounts: [],
      components: [component(60_000)],
    });
    // 775 * 6% = 46.5 -> 47, allocated 450:325 by largest remainder.
    expect(result.taxMinorUnits).toBe(47);
    expect(result.components[0]).toMatchObject({
      taxableMinorUnits: 775,
      taxMinorUnits: 47,
    });
    expect(result.lines.map((l) => l.taxMinorUnits)).toEqual([27, 20]);
    // Rounded once per component, not per line (per line would be 27 + 20
    // = 47 here, but 27 + 19.5 rounded separately shows the difference).
  });

  it('rounds once per component, never per line', () => {
    // Three lines of 25: per line 1.5 -> 2 each (6); for the order
    // 75 * 6% = 4.5 -> 5.
    const result = calculateSalesTax({
      currency: 'USD',
      lines: [line(0, 25), line(1, 25), line(2, 25)],
      discounts: [],
      components: [component(60_000)],
    });
    expect(result.taxMinorUnits).toBe(5);
    expect(result.lines.map((l) => l.taxMinorUnits)).toEqual([2, 2, 1]);
  });

  it('applies each component only to its own classes (mixed taxability)', () => {
    const result = calculateSalesTax({
      currency: 'USD',
      lines: [line(0, 1000, FOOD), line(1, 500, GROCERY), line(2, 300, EXEMPT)],
      discounts: [],
      components: [
        component(60_000, [FOOD, GROCERY], 'State'),
        component(10_000, [FOOD], 'City'),
      ],
    });
    expect(
      result.components.map((c) => [c.taxableMinorUnits, c.taxMinorUnits]),
    ).toEqual([
      [1500, 90],
      [1000, 10],
    ]);
    expect(result.lines.map((l) => l.componentTax)).toEqual([
      [60, 10],
      [30, 0],
      [0, 0],
    ]);
    expect(result.taxMinorUnits).toBe(100);
    // The exempt line is still part of the taxable merchandise, untaxed.
    expect(result.taxableMinorUnits).toBe(1800);
  });

  it('a confirmed zero-tax location calculates zero tax', () => {
    const result = calculateSalesTax({
      currency: 'USD',
      lines: [line(0, 999)],
      discounts: [],
      components: [],
    });
    expect(result.taxMinorUnits).toBe(0);
    expect(result.lines[0].taxMinorUnits).toBe(0);
  });

  it('taxes after store-funded discounts, allocated to the lines they applied to', () => {
    const result = calculateSalesTax({
      currency: 'USD',
      lines: [line(0, 600), line(1, 400), line(2, 1000, EXEMPT)],
      discounts: [
        // A promotion on lines 0 and 1 only.
        proRata(100, [0, 1]),
        // A fixed Mocha Bean reward on the whole order.
        proRata(190, null, 'REWARD'),
        // A freed unit on line 1.
        {
          kind: 'PROMOTION',
          funding: 'STORE',
          amount: 50,
          allocation: { type: 'LINE', lineIndex: 1 },
        },
      ],
      components: [component(60_000)],
    });
    expect(result.lines.map((l) => l.discountAllocations)).toEqual([
      [60, 54, 0],
      [40, 36, 50],
      [0, 100, 0],
    ]);
    expect(result.lines.map((l) => l.taxableMinorUnits)).toEqual([
      486, 274, 900,
    ]);
    // (486 + 274) * 6% = 45.6 -> 46.
    expect(result.taxMinorUnits).toBe(46);
    expect(result.discountMinorUnits).toBe(340);
    expect(result.taxableMinorUnits).toBe(1660);
  });

  it('a discount covering the whole order leaves nothing to tax', () => {
    const result = calculateSalesTax({
      currency: 'USD',
      lines: [line(0, 500)],
      discounts: [proRata(500, null, 'REWARD')],
      components: [component(60_000)],
    });
    expect(result.taxMinorUnits).toBe(0);
    expect(result.taxableMinorUnits).toBe(0);
  });

  it('is deterministic and reconciles exactly across many carts', () => {
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let run = 0; run < 300; run++) {
      const count = 1 + next(6);
      const lines = Array.from({ length: count }, (_, i) =>
        line(i, next(5000), [FOOD, GROCERY, EXEMPT][next(3)]),
      );
      const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
      const discount = subtotal === 0 ? 0 : next(subtotal + 1);
      const input = {
        currency: 'USD',
        lines,
        discounts: subtotal === 0 ? [] : [proRata(discount)],
        components: [
          component(1 + next(250_000), [FOOD, GROCERY], 'State'),
          component(1 + next(30_000), [FOOD], 'City'),
        ],
      };
      const a = calculateSalesTax(input);
      expect(calculateSalesTax(input)).toEqual(a);
      expect(() => assertTaxResultReconciles(a)).not.toThrow();
      expect(a.taxableMinorUnits).toBe(
        subtotal - (subtotal === 0 ? 0 : discount),
      );
    }
  });

  it('refuses inputs it cannot calculate exactly', () => {
    const base = {
      currency: 'USD',
      lines: [line(0, 100)],
      discounts: [] as TaxCalculationDiscount[],
      components: [component(60_000)],
    };
    expect(() => calculateSalesTax({ ...base, lines: [] })).toThrow(
      TaxCalculationError,
    );
    expect(() =>
      calculateSalesTax({ ...base, lines: [line(0, 10.5)] }),
    ).toThrow(TaxCalculationError);
    expect(() =>
      calculateSalesTax({ ...base, discounts: [proRata(101)] }),
    ).toThrow(TaxCalculationError);
    expect(() =>
      calculateSalesTax({ ...base, components: [component(0)] }),
    ).toThrow(TaxCalculationError);
    expect(() =>
      calculateSalesTax({ ...base, components: [component(250_001)] }),
    ).toThrow(TaxCalculationError);
    expect(() => calculateSalesTax({ ...base, currency: 'usd' })).toThrow(
      TaxCalculationError,
    );
  });

  it('detects a tampered result', () => {
    const result = calculateSalesTax({
      currency: 'USD',
      lines: [line(0, 1000), line(1, 1000)],
      discounts: [],
      components: [component(60_000)],
    });
    const tampered = {
      ...result,
      lines: result.lines.map((l, i) =>
        i === 0 ? { ...l, taxMinorUnits: l.taxMinorUnits - 1 } : l,
      ),
    };
    expect(() => assertTaxResultReconciles(tampered)).toThrow(
      TaxCalculationError,
    );
    expect(() =>
      assertTaxResultReconciles({ ...result, taxMinorUnits: 121 }),
    ).toThrow(TaxCalculationError);
  });
});
