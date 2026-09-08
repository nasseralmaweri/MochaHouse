import {
  computeRegularDiscount,
  type RegularDiscountConfig,
} from '@mocha-house/domain';

// Pure Milestone 7E regular Promotion/Coupon discount rules. All money is
// integer minor units.
describe('computeRegularDiscount', () => {
  const line = (
    over: Partial<{
      productId: string;
      categoryId: string;
      productName: string;
      unitPriceMinorUnits: number;
      quantity: number;
    }> = {},
  ) => ({
    productId: 'p1',
    categoryId: 'c1',
    productName: 'Latte',
    unitPriceMinorUnits: 500,
    quantity: 1,
    ...over,
  });

  const cfg = (over: Partial<RegularDiscountConfig> = {}): RegularDiscountConfig => ({
    discountType: 'PERCENTAGE_OFF',
    discountValue: 20,
    maxDiscountMinorUnits: null,
    applicability: 'ENTIRE_ORDER',
    eligibleProductIds: [],
    eligibleCategoryIds: [],
    minimumSubtotalMinorUnits: null,
    ...over,
  });

  // --- PERCENTAGE_OFF ------------------------------------------

  it('applies the percentage to eligible merchandise', () => {
    const result = computeRegularDiscount({
      grossSubtotalMinorUnits: 3000,
      lines: [line({ unitPriceMinorUnits: 3000 })],
      config: cfg({ discountValue: 20 }),
    });
    expect(result).toEqual({ ok: true, discountMinorUnits: 600, freeItem: null });
  });

  it('rounds half-up deterministically', () => {
    // $30.03 * 20% = 600.6 -> 601
    const result = computeRegularDiscount({
      grossSubtotalMinorUnits: 3003,
      lines: [line({ unitPriceMinorUnits: 3003 })],
      config: cfg({ discountValue: 20 }),
    });
    expect(result.ok && result.discountMinorUnits).toBe(601);
    // $10.01 * 25% = 250.25 -> 250
    const r2 = computeRegularDiscount({
      grossSubtotalMinorUnits: 1001,
      lines: [line({ unitPriceMinorUnits: 1001 })],
      config: cfg({ discountValue: 25 }),
    });
    expect(r2.ok && r2.discountMinorUnits).toBe(250);
  });

  it('caps the percentage discount at maxDiscountMinorUnits', () => {
    const result = computeRegularDiscount({
      grossSubtotalMinorUnits: 3000,
      lines: [line({ unitPriceMinorUnits: 3000 })],
      config: cfg({ discountValue: 20, maxDiscountMinorUnits: 500 }),
    });
    expect(result.ok && result.discountMinorUnits).toBe(500);
  });

  it('only discounts eligible merchandise for SELECTED_PRODUCTS', () => {
    const result = computeRegularDiscount({
      grossSubtotalMinorUnits: 1000,
      lines: [
        line({ productId: 'promo', unitPriceMinorUnits: 600 }),
        line({ productId: 'other', unitPriceMinorUnits: 400 }),
      ],
      config: cfg({
        discountValue: 50,
        applicability: 'SELECTED_PRODUCTS',
        eligibleProductIds: ['promo'],
      }),
    });
    // 50% of the $6 eligible product only
    expect(result.ok && result.discountMinorUnits).toBe(300);
  });

  // --- FIXED_AMOUNT -------------------------------------------

  it('applies a fixed amount, capped at the eligible merchandise', () => {
    const normal = computeRegularDiscount({
      grossSubtotalMinorUnits: 1000,
      lines: [line({ unitPriceMinorUnits: 1000 })],
      config: cfg({ discountType: 'FIXED_AMOUNT', discountValue: 500 }),
    });
    expect(normal.ok && normal.discountMinorUnits).toBe(500);

    const capped = computeRegularDiscount({
      grossSubtotalMinorUnits: 300,
      lines: [line({ unitPriceMinorUnits: 300 })],
      config: cfg({ discountType: 'FIXED_AMOUNT', discountValue: 500 }),
    });
    expect(capped.ok && capped.discountMinorUnits).toBe(300);
  });

  // --- FREE_ITEM ---------------------------------------------

  it('frees the lowest-priced eligible unit (by product)', () => {
    const result = computeRegularDiscount({
      grossSubtotalMinorUnits: 1500,
      lines: [
        line({ productId: 'pastry', unitPriceMinorUnits: 300 }),
        line({ productId: 'latte', unitPriceMinorUnits: 500 }),
        line({ productId: 'mocha', unitPriceMinorUnits: 700 }),
      ],
      config: cfg({
        discountType: 'FREE_ITEM',
        applicability: 'SELECTED_PRODUCTS',
        eligibleProductIds: ['pastry', 'latte', 'mocha'],
      }),
    });
    expect(result).toEqual({
      ok: true,
      discountMinorUnits: 300,
      freeItem: { productId: 'pastry', productName: 'Latte' },
    });
  });

  it('frees the lowest-priced eligible unit (by category)', () => {
    const result = computeRegularDiscount({
      grossSubtotalMinorUnits: 900,
      lines: [
        line({ productId: 'a', categoryId: 'drinks', unitPriceMinorUnits: 500 }),
        line({ productId: 'b', categoryId: 'food', unitPriceMinorUnits: 400 }),
      ],
      config: cfg({
        discountType: 'FREE_ITEM',
        applicability: 'SELECTED_CATEGORIES',
        eligibleCategoryIds: ['drinks'],
      }),
    });
    expect(result.ok && result.discountMinorUnits).toBe(500);
  });

  it('FREE_ITEM: quantity > 1 frees one unit, not the line', () => {
    const result = computeRegularDiscount({
      grossSubtotalMinorUnits: 1500,
      lines: [line({ productId: 'latte', unitPriceMinorUnits: 500, quantity: 3 })],
      config: cfg({
        discountType: 'FREE_ITEM',
        applicability: 'SELECTED_PRODUCTS',
        eligibleProductIds: ['latte'],
      }),
    });
    expect(result.ok && result.discountMinorUnits).toBe(500);
  });

  it('FREE_ITEM: rejected when no eligible item is in the cart', () => {
    const result = computeRegularDiscount({
      grossSubtotalMinorUnits: 500,
      lines: [line({ productId: 'latte' })],
      config: cfg({
        discountType: 'FREE_ITEM',
        applicability: 'SELECTED_PRODUCTS',
        eligibleProductIds: ['nope'],
      }),
    });
    expect(result).toMatchObject({ ok: false, code: 'NOT_APPLICABLE' });
  });

  // --- MINIMUM ---------------------------------------------

  it('rejects when the gross subtotal is below the minimum', () => {
    const result = computeRegularDiscount({
      grossSubtotalMinorUnits: 900,
      lines: [line({ unitPriceMinorUnits: 900 })],
      config: cfg({ minimumSubtotalMinorUnits: 1000 }),
    });
    expect(result).toMatchObject({ ok: false, code: 'MINIMUM_NOT_MET' });
  });

  it('applies when the gross subtotal meets the minimum exactly', () => {
    const result = computeRegularDiscount({
      grossSubtotalMinorUnits: 1000,
      lines: [line({ unitPriceMinorUnits: 1000 })],
      config: cfg({ discountValue: 10, minimumSubtotalMinorUnits: 1000 }),
    });
    expect(result.ok && result.discountMinorUnits).toBe(100);
  });

  it('never discounts below $0 and never more than the cart', () => {
    const result = computeRegularDiscount({
      grossSubtotalMinorUnits: 200,
      lines: [line({ unitPriceMinorUnits: 200 })],
      config: cfg({ discountType: 'FIXED_AMOUNT', discountValue: 100000 }),
    });
    expect(result.ok && result.discountMinorUnits).toBe(200);
  });
});
