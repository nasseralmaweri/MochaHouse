import {
  annualAmountFromDiscount,
  annualDiscountBasisPoints,
  parseBillingPolicy,
  parsePriceCreate,
  PriceInputError,
} from './pricing';

// SC3a — price and billing-policy input (E4/E5/E6): USD, monthly and annual,
// a configurable (never hard-coded) annual discount, configurable trial and
// grace lengths within bounds.
describe('SC3a pricing input', () => {
  it('accepts a monthly or annual amount in USD (currency optional)', () => {
    expect(
      parsePriceCreate({ interval: 'MONTH', amountMinorUnits: 4900 }),
    ).toEqual({
      interval: 'MONTH',
      currency: 'USD',
      amountMinorUnits: 4900,
    });
    expect(
      parsePriceCreate({
        interval: 'YEAR',
        currency: 'USD',
        amountMinorUnits: 49000,
      }),
    ).toMatchObject({ interval: 'YEAR', amountMinorUnits: 49000 });
  });

  it('accepts an annual discount instead of an amount — annual only', () => {
    expect(
      parsePriceCreate({ interval: 'YEAR', annualDiscountBasisPoints: 1500 }),
    ).toEqual({
      interval: 'YEAR',
      currency: 'USD',
      annualDiscountBasisPoints: 1500,
    });
    expect(() =>
      parsePriceCreate({ interval: 'MONTH', annualDiscountBasisPoints: 1500 }),
    ).toThrow(PriceInputError);
  });

  it.each([
    [{}],
    [{ interval: 'WEEK', amountMinorUnits: 100 }],
    [{ interval: 'MONTH' }],
    [
      {
        interval: 'MONTH',
        amountMinorUnits: 100,
        annualDiscountBasisPoints: 10,
      },
    ],
    [{ interval: 'MONTH', amountMinorUnits: 0 }],
    [{ interval: 'MONTH', amountMinorUnits: 10.5 }],
    [{ interval: 'MONTH', amountMinorUnits: 100_000_001 }],
    [{ interval: 'MONTH', amountMinorUnits: '4900' }],
    [{ interval: 'MONTH', currency: 'EUR', amountMinorUnits: 100 }],
    [{ interval: 'YEAR', annualDiscountBasisPoints: 0 }],
    [{ interval: 'YEAR', annualDiscountBasisPoints: 10_000 }],
    [{ interval: 'MONTH', amountMinorUnits: 100, planId: 'x' }],
    [null],
    [[]],
  ])('refuses %j', (body) => {
    expect(() => parsePriceCreate(body)).toThrow(PriceInputError);
  });

  it('derives an annual amount from twelve monthly payments and the given discount', () => {
    expect(annualAmountFromDiscount(4900, 1500)).toBe(49980); // 58800 * 0.85
    expect(annualAmountFromDiscount(4900, 1667)).toBe(48998); // rounded to the cent
    expect(annualAmountFromDiscount(1, 9999)).toBe(1); // never below one cent
    expect(annualDiscountBasisPoints(4900, 49980)).toBe(1500);
    expect(annualDiscountBasisPoints(4900, 60000)).toBe(0);
  });

  it('accepts a billing policy within bounds and refuses anything else', () => {
    expect(
      parseBillingPolicy({
        trialDays: 0,
        trialRequiresPaymentMethod: false,
        gracePeriodDays: 1,
      }),
    ).toEqual({
      trialDays: 0,
      trialRequiresPaymentMethod: false,
      gracePeriodDays: 1,
    });
    for (const body of [
      { trialDays: 91, trialRequiresPaymentMethod: true, gracePeriodDays: 14 },
      { trialDays: -1, trialRequiresPaymentMethod: true, gracePeriodDays: 14 },
      { trialDays: 14, trialRequiresPaymentMethod: 'yes', gracePeriodDays: 14 },
      { trialDays: 14, trialRequiresPaymentMethod: true, gracePeriodDays: 0 },
      { trialDays: 14, trialRequiresPaymentMethod: true, gracePeriodDays: 61 },
      {
        trialDays: 14,
        trialRequiresPaymentMethod: true,
        gracePeriodDays: 14,
        extra: 1,
      },
    ]) {
      expect(() => parseBillingPolicy(body)).toThrow(PriceInputError);
    }
  });
});
