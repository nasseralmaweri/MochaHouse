import {
  TAX_RATE_PPM_MAX,
  formatTaxRatePpm,
  parseTaxRatePercent,
} from '@mocha-house/contracts';

// V1 Sales Tax PR 1 — rates are exact integers (parts per million), parsed
// from the typed percentage digit by digit: never through a float.
describe('tax rate parsing (exact)', () => {
  it.each([
    ['6', 60_000],
    ['6.0', 60_000],
    ['6.25', 62_500],
    ['6.2500', 62_500],
    ['0.0001', 1],
    ['0.0125', 125],
    ['7.1234', 71_234],
    ['25', 250_000],
    [' 4.5 % ', 45_000],
    // Values whose float arithmetic is inexact (0.1 + 0.2, 1.005 * 100, ...).
    ['0.3', 3_000],
    ['1.005', 10_050],
    ['2.675', 26_750],
  ])('%p is %p ppm', (input, ppm) => {
    expect(parseTaxRatePercent(input)).toEqual({ ok: true, ratePpm: ppm });
  });

  it.each([
    [6.25],
    [null],
    [''],
    ['0'],
    ['0.00001'],
    ['25.0001'],
    ['100'],
    ['-6'],
    ['+6'],
    ['6,25'],
    ['1e1'],
    ['.5'],
    ['6.'],
    ['0x10'],
    ['６'],
  ])('%p is refused', (input) => {
    expect(parseTaxRatePercent(input).ok).toBe(false);
  });

  it('formats every rate back exactly', () => {
    expect(formatTaxRatePpm(60_000)).toBe('6');
    expect(formatTaxRatePpm(62_500)).toBe('6.25');
    expect(formatTaxRatePpm(1)).toBe('0.0001');
    expect(formatTaxRatePpm(10_050)).toBe('1.005');
    for (let ppm = 1; ppm <= TAX_RATE_PPM_MAX; ppm += 97) {
      expect(parseTaxRatePercent(formatTaxRatePpm(ppm))).toEqual({
        ok: true,
        ratePpm: ppm,
      });
    }
    expect(() => formatTaxRatePpm(1.5)).toThrow(RangeError);
    expect(() => formatTaxRatePpm(-1)).toThrow(RangeError);
  });
});
