import {
  MOCHA_BEANS_PER_DOLLAR,
  mochaBeansForQualifyingSpend,
} from '@mocha-house/domain';

// Pure earning-calculation rules for Milestone 7A. Qualifying spend is an
// integer number of cents; earning is whole qualifying DOLLARS only,
// truncated (never rounded).
describe('mochaBeansForQualifyingSpend', () => {
  it('uses the 7A default rate of $1 = 1 Mocha Bean', () => {
    expect(MOCHA_BEANS_PER_DOLLAR).toBe(1);
  });

  it('awards whole qualifying dollars only, truncating the remainder', () => {
    expect(mochaBeansForQualifyingSpend(99)).toBe(0); // $0.99
    expect(mochaBeansForQualifyingSpend(100)).toBe(1); // $1.00
    expect(mochaBeansForQualifyingSpend(875)).toBe(8); // $8.75
    expect(mochaBeansForQualifyingSpend(899)).toBe(8); // $8.99
    expect(mochaBeansForQualifyingSpend(1200)).toBe(12); // $12.00
    expect(mochaBeansForQualifyingSpend(1999)).toBe(19); // $19.99
  });

  it('never awards Beans for a zero, negative, or non-integer subtotal', () => {
    expect(mochaBeansForQualifyingSpend(0)).toBe(0);
    expect(mochaBeansForQualifyingSpend(-500)).toBe(0);
    expect(mochaBeansForQualifyingSpend(12.5)).toBe(0);
    expect(mochaBeansForQualifyingSpend(Number.NaN)).toBe(0);
    expect(mochaBeansForQualifyingSpend(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('scales linearly with the qualifying dollar amount', () => {
    expect(mochaBeansForQualifyingSpend(10_000)).toBe(100); // $100.00
    expect(mochaBeansForQualifyingSpend(10_050)).toBe(100); // $100.50
  });
});
