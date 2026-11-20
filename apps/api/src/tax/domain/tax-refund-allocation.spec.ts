import {
  ItemRefundError,
  allocateItemRefund,
  type PriorLineRefund,
  type SnapshotTaxLine,
} from './tax-refund-allocation';

// V1 Sales Tax PR 3 — item refunds from the original snapshot, exactly.
const KEYS = ['state', 'city'];
// Line 0: 3 coffees, $10.00 net, state 60 + city 13 tax.
// Line 1: an exempt bag of beans, $12.99 net, no tax.
const LINES: SnapshotTaxLine[] = [
  {
    lineIndex: 0,
    quantity: 3,
    merchandiseMinorUnits: 1000,
    componentTax: [60, 13],
  },
  {
    lineIndex: 1,
    quantity: 1,
    merchandiseMinorUnits: 1299,
    componentTax: [0, 0],
  },
];

const add = (
  prior: Map<number, PriorLineRefund>,
  result: ReturnType<typeof allocateItemRefund>,
) => {
  for (const line of result.lines) {
    const p = prior.get(line.lineIndex) ?? {
      quantity: 0,
      merchandiseMinorUnits: 0,
      componentTax: KEYS.map(() => 0),
    };
    prior.set(line.lineIndex, {
      quantity: p.quantity + line.quantity,
      merchandiseMinorUnits:
        p.merchandiseMinorUnits + line.merchandiseMinorUnits,
      componentTax: p.componentTax.map((t, c) => t + line.componentTax[c]),
    });
  }
};

describe('allocateItemRefund', () => {
  it('refunds a whole line exactly, by component', () => {
    const r = allocateItemRefund({
      componentKeys: KEYS,
      lines: LINES,
      prior: new Map(),
      items: [{ lineIndex: 0, quantity: 3 }],
    });
    expect(r).toMatchObject({
      merchandiseMinorUnits: 1000,
      componentTax: [60, 13],
      taxMinorUnits: 73,
      totalMinorUnits: 1073,
    });
  });

  it('partial refunds of a line always add up to exactly the line, never more', () => {
    const prior = new Map<number, PriorLineRefund>();
    const first = allocateItemRefund({
      componentKeys: KEYS,
      lines: LINES,
      prior,
      items: [{ lineIndex: 0, quantity: 1 }],
    });
    // floor(1000/3)=333, floor(60/3)=20, floor(13/3)=4.
    expect(first.lines[0]).toMatchObject({
      merchandiseMinorUnits: 333,
      componentTax: [20, 4],
    });
    add(prior, first);
    const second = allocateItemRefund({
      componentKeys: KEYS,
      lines: LINES,
      prior,
      items: [{ lineIndex: 0, quantity: 1 }],
    });
    // floor(2000/3)=666 -> 333; floor(120/3)=40 -> 20; floor(26/3)=8 -> 4.
    expect(second.lines[0]).toMatchObject({
      merchandiseMinorUnits: 333,
      componentTax: [20, 4],
    });
    add(prior, second);
    const last = allocateItemRefund({
      componentKeys: KEYS,
      lines: LINES,
      prior,
      items: [{ lineIndex: 0, quantity: 1 }],
    });
    // The last unit takes exactly what is left.
    expect(last.lines[0]).toMatchObject({
      merchandiseMinorUnits: 334,
      componentTax: [20, 5],
    });
    add(prior, last);
    expect(prior.get(0)).toEqual({
      quantity: 3,
      merchandiseMinorUnits: 1000,
      componentTax: [60, 13],
    });
    expect(() =>
      allocateItemRefund({
        componentKeys: KEYS,
        lines: LINES,
        prior,
        items: [{ lineIndex: 0, quantity: 1 }],
      }),
    ).toThrow('Every unit of that item has already been refunded.');
  });

  it('mixed taxable and exempt items: the exempt item returns no tax', () => {
    const r = allocateItemRefund({
      componentKeys: KEYS,
      lines: LINES,
      prior: new Map(),
      items: [
        { lineIndex: 1, quantity: 1 },
        { lineIndex: 0, quantity: 2 },
      ],
    });
    expect(
      r.lines.map((l) => [
        l.lineIndex,
        l.merchandiseMinorUnits,
        l.taxMinorUnits,
      ]),
    ).toEqual([
      [0, 666, 48],
      [1, 1299, 0],
    ]);
    expect(r.totalMinorUnits).toBe(666 + 48 + 1299);
  });

  it('a refund whose card refund failed frees its units again (prior counts only live ones)', () => {
    const prior = new Map<number, PriorLineRefund>();
    // A refund of 2 units failed: it is simply not in `prior`.
    const r = allocateItemRefund({
      componentKeys: KEYS,
      lines: LINES,
      prior,
      items: [{ lineIndex: 0, quantity: 3 }],
    });
    expect(r.taxMinorUnits).toBe(73);
  });

  it('refuses what cannot be refunded', () => {
    const base = { componentKeys: KEYS, lines: LINES, prior: new Map() };
    const refused = (items: { lineIndex: number; quantity: number }[]) =>
      expect(() => allocateItemRefund({ ...base, items })).toThrow(
        ItemRefundError,
      );
    refused([]);
    refused([{ lineIndex: 0, quantity: 4 }]);
    refused([{ lineIndex: 0, quantity: 0 }]);
    refused([{ lineIndex: 0, quantity: 1.5 }]);
    refused([{ lineIndex: 9, quantity: 1 }]);
    refused([
      { lineIndex: 0, quantity: 1 },
      { lineIndex: 0, quantity: 1 },
    ]);
  });

  it('never returns more than a line was charged, in any order of partial refunds', () => {
    const line: SnapshotTaxLine = {
      lineIndex: 0,
      quantity: 7,
      merchandiseMinorUnits: 1001,
      componentTax: [61, 1],
    };
    for (const steps of [
      [1, 1, 1, 1, 1, 1, 1],
      [3, 4],
      [6, 1],
      [2, 2, 3],
    ]) {
      const prior = new Map<number, PriorLineRefund>();
      for (const quantity of steps) {
        const r = allocateItemRefund({
          componentKeys: KEYS,
          lines: [line],
          prior,
          items: [{ lineIndex: 0, quantity }],
        });
        add(prior, r);
        const p = prior.get(0)!;
        expect(p.merchandiseMinorUnits).toBeLessThanOrEqual(1001);
        expect(p.componentTax[0]).toBeLessThanOrEqual(61);
        expect(p.componentTax[1]).toBeLessThanOrEqual(1);
      }
      expect(prior.get(0)).toEqual({
        quantity: 7,
        merchandiseMinorUnits: 1001,
        componentTax: [61, 1],
      });
    }
  });
});
