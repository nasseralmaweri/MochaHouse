import { computeLoyaltyRewardDiscount } from '@mocha-house/domain';

// Pure Milestone 7C reward-discount rules. All money is integer minor units.
describe('computeLoyaltyRewardDiscount', () => {
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
    unitPriceMinorUnits: 400,
    quantity: 1,
    ...over,
  });

  describe('FIXED_AMOUNT', () => {
    it('discounts the fixed value when the cart covers it', () => {
      const result = computeLoyaltyRewardDiscount({
        merchandiseSubtotalMinorUnits: 1500,
        lines: [line({ unitPriceMinorUnits: 1500 })],
        reward: { type: 'FIXED_AMOUNT', fixedAmountMinorUnits: 500 },
      });
      expect(result).toEqual({ ok: true, discountMinorUnits: 500, freeItem: null });
    });

    it('caps the discount at the merchandise subtotal — never below $0', () => {
      const result = computeLoyaltyRewardDiscount({
        merchandiseSubtotalMinorUnits: 350,
        lines: [line({ unitPriceMinorUnits: 350 })],
        reward: { type: 'FIXED_AMOUNT', fixedAmountMinorUnits: 500 },
      });
      expect(result).toEqual({ ok: true, discountMinorUnits: 350, freeItem: null });
    });

    it('is always eligible for a non-empty cart', () => {
      const result = computeLoyaltyRewardDiscount({
        merchandiseSubtotalMinorUnits: 200,
        lines: [line({ productId: 'other', categoryId: 'other' })],
        reward: { type: 'FIXED_AMOUNT', fixedAmountMinorUnits: 500 },
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('FREE_ITEM', () => {
    it('is eligible when a cart line matches by product id', () => {
      const result = computeLoyaltyRewardDiscount({
        merchandiseSubtotalMinorUnits: 400,
        lines: [line({ productId: 'latte', unitPriceMinorUnits: 400 })],
        reward: {
          type: 'FREE_ITEM',
          eligibleProductIds: ['latte'],
          eligibleCategoryIds: [],
        },
      });
      expect(result).toEqual({
        ok: true,
        discountMinorUnits: 400,
        freeItem: { productId: 'latte', productName: 'Latte' },
      });
    });

    it('is eligible when a cart line matches by category id', () => {
      const result = computeLoyaltyRewardDiscount({
        merchandiseSubtotalMinorUnits: 500,
        lines: [
          line({ productId: 'x', categoryId: 'drinks', unitPriceMinorUnits: 500 }),
        ],
        reward: {
          type: 'FREE_ITEM',
          eligibleProductIds: [],
          eligibleCategoryIds: ['drinks'],
        },
      });
      expect(result.ok && result.discountMinorUnits).toBe(500);
    });

    it('rejects when no cart line is eligible', () => {
      const result = computeLoyaltyRewardDiscount({
        merchandiseSubtotalMinorUnits: 400,
        lines: [line({ productId: 'p1', categoryId: 'c1' })],
        reward: {
          type: 'FREE_ITEM',
          eligibleProductIds: ['nope'],
          eligibleCategoryIds: ['also-nope'],
        },
      });
      expect(result).toMatchObject({ ok: false, code: 'REWARD_NOT_ELIGIBLE' });
    });

    it('frees the LOWEST-priced eligible unit when several match', () => {
      const result = computeLoyaltyRewardDiscount({
        merchandiseSubtotalMinorUnits: 1500,
        lines: [
          line({ productId: 'pastry', unitPriceMinorUnits: 300 }),
          line({ productId: 'latte', unitPriceMinorUnits: 500 }),
          line({ productId: 'mocha', unitPriceMinorUnits: 700 }),
        ],
        reward: {
          type: 'FREE_ITEM',
          eligibleProductIds: ['pastry', 'latte', 'mocha'],
          eligibleCategoryIds: [],
        },
      });
      expect(result).toEqual({
        ok: true,
        discountMinorUnits: 300,
        freeItem: { productId: 'pastry', productName: 'Latte' },
      });
    });

    it('frees ONE unit, not the whole line, when quantity > 1', () => {
      const result = computeLoyaltyRewardDiscount({
        merchandiseSubtotalMinorUnits: 1200,
        lines: [line({ productId: 'latte', unitPriceMinorUnits: 400, quantity: 3 })],
        reward: {
          type: 'FREE_ITEM',
          eligibleProductIds: ['latte'],
          eligibleCategoryIds: [],
        },
      });
      expect(result.ok && result.discountMinorUnits).toBe(400); // one unit, not 1200
    });

    it('breaks ties on productId deterministically', () => {
      const a = computeLoyaltyRewardDiscount({
        merchandiseSubtotalMinorUnits: 800,
        lines: [
          line({ productId: 'bbb', unitPriceMinorUnits: 400 }),
          line({ productId: 'aaa', unitPriceMinorUnits: 400 }),
        ],
        reward: {
          type: 'FREE_ITEM',
          eligibleProductIds: ['aaa', 'bbb'],
          eligibleCategoryIds: [],
        },
      });
      expect(a.ok && a.freeItem?.productId).toBe('aaa');
    });
  });
});
