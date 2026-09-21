import { completedPercent } from './location-performance.service';

// Milestone 9B — the deterministic Completed % rounding rule, isolated
// from the database. Integer-scaled rounding (Math.round on a numerator
// pre-multiplied by 1000, then divided by 10) so the result is exact and
// never subject to floating-point display ambiguity.
describe('completedPercent (Milestone 9B)', () => {
  it('matches the approved rounding examples', () => {
    expect(completedPercent(1, 3)).toBe(33.3);
    expect(completedPercent(2, 3)).toBe(66.7);
    expect(completedPercent(1, 6)).toBe(16.7);
    expect(completedPercent(0, 0)).toBe(0);
  });

  it('is 0 when totalOrders is 0, never NaN or Infinity', () => {
    expect(completedPercent(0, 0)).toBe(0);
    expect(Number.isFinite(completedPercent(0, 0))).toBe(true);
  });

  it('is 100 when every order is completed', () => {
    expect(completedPercent(5, 5)).toBe(100);
  });

  it('is 0 when no order is completed', () => {
    expect(completedPercent(0, 4)).toBe(0);
  });

  it('rounds an exact tenths-of-a-percent half-way case deterministically', () => {
    // 1/80 * 1000 = 12.5 exactly (the pre-rounding value, in tenths of a
    // percent) — a genuine half-way case for Math.round, not just a
    // repeating-decimal approximation. Math.round rounds .5 up, so this is
    // 1.3%, not 1.2%.
    expect(completedPercent(1, 80)).toBe(1.3);
  });
});
