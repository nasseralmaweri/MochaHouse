import {
  computeOrderLoyaltyBonuses,
  type BonusPromotionInput,
} from '@mocha-house/domain';

// Pure Milestone 7D bonus-earning rules. All money is integer minor units.
// The standard order-level EARN is unchanged by these — this function
// returns only the BONUS_EARN contribution.
describe('computeOrderLoyaltyBonuses', () => {
  const line = (
    over: Partial<{
      productId: string;
      productName: string;
      unitPriceMinorUnits: number;
      quantity: number;
    }> = {},
  ) => ({
    productId: 'promoted',
    productName: 'Mango Matcha',
    unitPriceMinorUnits: 600,
    quantity: 1,
    ...over,
  });

  const extra = (
    bonusValue: number,
    productIds: string[] = ['promoted'],
    over: Partial<BonusPromotionInput> = {},
  ): BonusPromotionInput => ({
    id: over.id ?? 'promo-extra',
    name: over.name ?? `+${bonusValue} Beans`,
    type: 'EXTRA_BEANS',
    bonusValue,
    eligibleProductIds: productIds,
  });

  const multiplier = (
    bonusValue: number,
    productIds: string[] = ['promoted'],
    over: Partial<BonusPromotionInput> = {},
  ): BonusPromotionInput => ({
    id: over.id ?? 'promo-mult',
    name: over.name ?? `${bonusValue}x`,
    type: 'MULTIPLIER',
    bonusValue,
    eligibleProductIds: productIds,
  });

  const base = {
    standardRatePerDollar: 1,
    freeUnitLineIndices: [],
    orderLevelDiscounts: [],
  };

  // --- EXTRA_BEANS ---------------------------------------------

  it('EXTRA_BEANS: an eligible product earns the flat bonus on top of standard', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      lines: [line({ unitPriceMinorUnits: 600 })], // $6
      promotions: [extra(20)],
    });
    expect(result.totalBonusBeans).toBe(20);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      promotionType: 'EXTRA_BEANS',
      qualifyingUnits: 1,
      standardBeansForItem: 6,
      bonusBeans: 20,
    });
  });

  it('EXTRA_BEANS: multiplies per qualifying paid unit', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      lines: [line({ productId: 'latte', unitPriceMinorUnits: 400, quantity: 3 })],
      promotions: [extra(10, ['latte'])],
    });
    expect(result.totalBonusBeans).toBe(30); // 10 * 3
  });

  it('a non-target product gets no bonus', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      lines: [line({ productId: 'plain', unitPriceMinorUnits: 600 })],
      promotions: [extra(20, ['promoted'])],
    });
    expect(result.totalBonusBeans).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it('the configured standard rate does not change the flat EXTRA_BEANS bonus', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      standardRatePerDollar: 5,
      lines: [line({ unitPriceMinorUnits: 600 })],
      promotions: [extra(20)],
    });
    expect(result.totalBonusBeans).toBe(20);
    expect(result.items[0].standardBeansForItem).toBe(30); // 6 * 5, informational
  });

  // --- MULTIPLIER ---------------------------------------------

  it('MULTIPLIER: 2x contributes one extra standard-earning, not double', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      lines: [line({ unitPriceMinorUnits: 600 })], // $6 -> 6 standard
      promotions: [multiplier(2)],
    });
    // total item earning is 12: 6 standard + 6 bonus contribution
    expect(result.totalBonusBeans).toBe(6);
    expect(result.items[0]).toMatchObject({
      standardBeansForItem: 6,
      bonusBeans: 6,
    });
  });

  it('MULTIPLIER: 3x contributes twice the standard item earning', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      lines: [line({ unitPriceMinorUnits: 500 })],
      promotions: [multiplier(3)],
    });
    expect(result.totalBonusBeans).toBe(10); // 5 * (3 - 1)
  });

  it('MULTIPLIER: respects the configured standard rate', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      standardRatePerDollar: 2,
      lines: [line({ unitPriceMinorUnits: 500 })], // $5 -> 10 standard at rate 2
      promotions: [multiplier(2)],
    });
    expect(result.totalBonusBeans).toBe(10); // 10 * (2 - 1)
  });

  it('MULTIPLIER: bonus is per qualifying spend, not per line-item flat', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      lines: [line({ productId: 'latte', unitPriceMinorUnits: 400, quantity: 3 })],
      promotions: [multiplier(2, ['latte'])],
    });
    // 3 paid units * $4 = $12 -> 12 standard -> 12 bonus
    expect(result.totalBonusBeans).toBe(12);
    expect(result.items[0].qualifyingUnits).toBe(3);
  });

  it('only the promoted item earns a bonus, not the whole order', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      lines: [
        line({ productId: 'promoted', unitPriceMinorUnits: 600 }),
        line({ productId: 'plain', unitPriceMinorUnits: 400 }),
      ],
      promotions: [multiplier(2, ['promoted'])],
    });
    // promoted: 6 base -> 12 total (bonus +6); plain: nothing
    expect(result.totalBonusBeans).toBe(6);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].productId).toBe('promoted');
  });

  // --- BEST PROMOTION ----------------------------------------

  it('applies only the single highest-value promotion on an item', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      lines: [line({ unitPriceMinorUnits: 800 })], // $8 -> 8 standard
      promotions: [extra(10), multiplier(2)], // +10 vs +8
    });
    expect(result.totalBonusBeans).toBe(10);
    expect(result.items[0].promotionType).toBe('EXTRA_BEANS');
  });

  it('picks the multiplier when it wins on a bigger item', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      lines: [line({ unitPriceMinorUnits: 2000 })], // $20 -> 20 standard
      promotions: [extra(10), multiplier(2)], // +10 vs +20
    });
    expect(result.totalBonusBeans).toBe(20);
    expect(result.items[0].promotionType).toBe('MULTIPLIER');
  });

  it('breaks ties by the caller-supplied promotion order (first wins)', () => {
    const a = computeOrderLoyaltyBonuses({
      ...base,
      lines: [line({ unitPriceMinorUnits: 1000 })], // $10 -> 10 standard
      // +10 EXTRA vs 2x (contributes +10): a tie
      promotions: [
        extra(10, ['promoted'], { id: 'aaa' }),
        multiplier(2, ['promoted'], { id: 'bbb' }),
      ],
    });
    expect(a.items[0].sourcePromotionId).toBe('aaa');

    const b = computeOrderLoyaltyBonuses({
      ...base,
      lines: [line({ unitPriceMinorUnits: 1000 })],
      promotions: [
        multiplier(2, ['promoted'], { id: 'bbb' }),
        extra(10, ['promoted'], { id: 'aaa' }),
      ],
    });
    expect(b.items[0].sourcePromotionId).toBe('bbb');
  });

  // --- FREE_ITEM interaction --------------------------------

  it('a FREE_ITEM-reward free unit earns no EXTRA_BEANS bonus', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      freeUnitLineIndices: [0],
      lines: [line({ productId: 'promoted', unitPriceMinorUnits: 600, quantity: 1 })],
      promotions: [extra(20)],
    });
    expect(result.totalBonusBeans).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it('a FREE_ITEM-reward free unit earns no spend-based multiplier bonus, but paid units still do', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      freeUnitLineIndices: [0],
      lines: [line({ productId: 'promoted', unitPriceMinorUnits: 600, quantity: 3 })],
      promotions: [multiplier(2)],
    });
    // 2 paid units * $6 = $12 -> 12 standard -> 12 bonus
    expect(result.totalBonusBeans).toBe(12);
    expect(result.items[0].qualifyingUnits).toBe(2);
  });

  // --- FIXED_AMOUNT interaction -----------------------------

  it('a FIXED_AMOUNT reward discount lowers the multiplier qualifying spend proportionally', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      orderLevelDiscounts: [{ amountMinorUnits: 500, eligibleProductIds: null }], // $5 off the order
      lines: [
        line({ productId: 'promoted', unitPriceMinorUnits: 600 }), // $6
        line({ productId: 'plain', unitPriceMinorUnits: 400 }), // $4
      ],
      promotions: [multiplier(2, ['promoted'])],
    });
    // $5 discount over $10 paid gross -> $3 to the promoted line ($6 * 5/10),
    // so promoted qualifying spend = $6 - $3 = $3 -> 3 standard -> 3 bonus
    expect(result.items[0].qualifyingSpendMinorUnits).toBe(300);
    expect(result.totalBonusBeans).toBe(3);
  });

  it('EXTRA_BEANS is still awarded on a fixed-discounted paid unit', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      orderLevelDiscounts: [{ amountMinorUnits: 600, eligibleProductIds: null }],
      lines: [line({ productId: 'promoted', unitPriceMinorUnits: 600 })],
      promotions: [extra(20)],
    });
    expect(result.totalBonusBeans).toBe(20);
  });

  // --- TARGETED regular discount buckets (Milestone 7E) ------

  it('a targeted regular discount does NOT reduce an unrelated product’s multiplier spend', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      // 50% off Product A only -> $5, eligible to ['A'].
      orderLevelDiscounts: [{ amountMinorUnits: 500, eligibleProductIds: ['A'] }],
      lines: [
        line({ productId: 'A', unitPriceMinorUnits: 1000 }),
        line({ productId: 'B', unitPriceMinorUnits: 1000 }),
      ],
      promotions: [multiplier(2, ['B'])],
    });
    // B untouched -> qualifying $10 -> 10 standard -> 10 bonus (NOT 7).
    expect(result.items[0].productId).toBe('B');
    expect(result.items[0].qualifyingSpendMinorUnits).toBe(1000);
    expect(result.totalBonusBeans).toBe(10);
  });

  it('a targeted regular discount DOES reduce the discounted product’s own multiplier spend', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      orderLevelDiscounts: [{ amountMinorUnits: 500, eligibleProductIds: ['A'] }],
      lines: [
        line({ productId: 'A', unitPriceMinorUnits: 1000 }),
        line({ productId: 'B', unitPriceMinorUnits: 1000 }),
      ],
      promotions: [multiplier(2, ['A'])],
    });
    // A discounted to $5 -> 5 standard -> 5 bonus (NOT 7.5-rounded).
    expect(result.items[0].qualifyingSpendMinorUnits).toBe(500);
    expect(result.totalBonusBeans).toBe(5);
  });

  it('an ENTIRE_ORDER discount keeps the proportional-across-all allocation', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      orderLevelDiscounts: [{ amountMinorUnits: 500, eligibleProductIds: null }],
      lines: [
        line({ productId: 'A', unitPriceMinorUnits: 1000 }),
        line({ productId: 'B', unitPriceMinorUnits: 1000 }),
      ],
      promotions: [multiplier(2, ['B'])],
    });
    // $5 spread proportionally -> B qualifying $7.50 -> 7 standard -> 7 bonus.
    expect(result.items[0].qualifyingSpendMinorUnits).toBe(750);
    expect(result.totalBonusBeans).toBe(7);
  });

  it('two discount buckets deplete each line sequentially — total attributed never exceeds paid value', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      // Regular 50%-off-A ($5, targeted) + a $5 order-wide FIXED reward.
      orderLevelDiscounts: [
        { amountMinorUnits: 500, eligibleProductIds: ['A'] },
        { amountMinorUnits: 500, eligibleProductIds: null },
      ],
      lines: [
        line({ productId: 'A', unitPriceMinorUnits: 1000 }),
        line({ productId: 'B', unitPriceMinorUnits: 1000 }),
      ],
      promotions: [multiplier(2, ['A']), multiplier(2, ['B'])],
    });
    // Total non-free discount = $10; paid gross = $20; final merchandise $10.
    const totalQualifying = result.items.reduce(
      (s, it) => s + it.qualifyingSpendMinorUnits,
      0,
    );
    expect(totalQualifying).toBe(1000);
    // Neither line's qualifying spend is negative or above its paid value.
    for (const it of result.items) {
      expect(it.qualifyingSpendMinorUnits).toBeGreaterThanOrEqual(0);
      expect(it.qualifyingSpendMinorUnits).toBeLessThanOrEqual(1000);
    }
  });

  it('a free unit is pinned to its exact priced line', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      // The $6 line (index 1) is the freed unit, not the $4 line (index 0).
      freeUnitLineIndices: [1],
      lines: [
        line({ productId: 'X', unitPriceMinorUnits: 400 }), // small
        line({ productId: 'X', unitPriceMinorUnits: 600 }), // large
      ],
      promotions: [extra(10, ['X'])],
    });
    // Only the $4 small unit is still paid -> +10 once.
    expect(result.totalBonusBeans).toBe(10);
    expect(result.items[0].qualifyingUnits).toBe(1);
  });

  // --- EMPTY / EDGE ----------------------------------------

  it('returns nothing when there are no promotions', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      lines: [line()],
      promotions: [],
    });
    expect(result).toEqual({ totalBonusBeans: 0, items: [] });
  });

  it('MULTIPLIER on a sub-$1 qualifying item contributes nothing', () => {
    const result = computeOrderLoyaltyBonuses({
      ...base,
      lines: [line({ unitPriceMinorUnits: 75 })],
      promotions: [multiplier(2)],
    });
    expect(result.totalBonusBeans).toBe(0);
  });
});
