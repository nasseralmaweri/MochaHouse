import {
  DEFAULT_MOCHA_BEANS_PER_DOLLAR,
  MOCHA_BEANS_PER_DOLLAR,
  mochaBeansForQualifyingSpend,
} from '@mocha-house/domain';

// Pure earning-calculation rules. Qualifying spend is an integer number of
// cents; earning is whole qualifying DOLLARS only, truncated (never
// rounded). Milestone 7B adds the HQ-configurable rate parameter.
describe('mochaBeansForQualifyingSpend', () => {
  it('defaults to $1 = 1 Mocha Bean (preserving 7A behaviour)', () => {
    expect(MOCHA_BEANS_PER_DOLLAR).toBe(1);
    expect(DEFAULT_MOCHA_BEANS_PER_DOLLAR).toBe(1);
    expect(mochaBeansForQualifyingSpend(500)).toBe(5);
  });

  it('awards whole qualifying dollars only, truncating the remainder', () => {
    expect(mochaBeansForQualifyingSpend(99)).toBe(0); // $0.99
    expect(mochaBeansForQualifyingSpend(100)).toBe(1); // $1.00
    expect(mochaBeansForQualifyingSpend(875)).toBe(8); // $8.75
    expect(mochaBeansForQualifyingSpend(899)).toBe(8); // $8.99
    expect(mochaBeansForQualifyingSpend(1200)).toBe(12); // $12.00
    expect(mochaBeansForQualifyingSpend(1999)).toBe(19); // $19.99
  });

  it('applies the configured rate to whole qualifying dollars (Milestone 7B)', () => {
    // rate 2: $8.75 -> 8 whole dollars -> 16 Beans (the approved example)
    expect(mochaBeansForQualifyingSpend(875, 2)).toBe(16);
    expect(mochaBeansForQualifyingSpend(100, 2)).toBe(2);
    expect(mochaBeansForQualifyingSpend(99, 2)).toBe(0);
    // rate 3
    expect(mochaBeansForQualifyingSpend(1200, 3)).toBe(36);
    // rate 1 explicitly
    expect(mochaBeansForQualifyingSpend(1200, 1)).toBe(12);
  });

  it('never awards Beans for a zero, negative, or non-integer subtotal', () => {
    expect(mochaBeansForQualifyingSpend(0)).toBe(0);
    expect(mochaBeansForQualifyingSpend(-500)).toBe(0);
    expect(mochaBeansForQualifyingSpend(12.5)).toBe(0);
    expect(mochaBeansForQualifyingSpend(Number.NaN)).toBe(0);
    expect(mochaBeansForQualifyingSpend(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('never awards Beans for a malformed rate', () => {
    expect(mochaBeansForQualifyingSpend(1000, 0)).toBe(0);
    expect(mochaBeansForQualifyingSpend(1000, -2)).toBe(0);
    expect(mochaBeansForQualifyingSpend(1000, 1.5)).toBe(0);
    expect(mochaBeansForQualifyingSpend(1000, Number.NaN)).toBe(0);
  });

  it('scales linearly with the qualifying dollar amount', () => {
    expect(mochaBeansForQualifyingSpend(10_000)).toBe(100); // $100.00
    expect(mochaBeansForQualifyingSpend(10_050)).toBe(100); // $100.50
  });
});
