import {
  MOCHA_HOUSE_TIME_ZONE,
  businessDateToProjection,
  businessDateToStorage,
  resolveBusinessDate,
} from './business-date';

describe('business-date helper (Milestone 6B)', () => {
  it('uses America/Detroit as the single business timezone', () => {
    expect(MOCHA_HOUSE_TIME_ZONE).toBe('America/Detroit');
  });

  it('resolves the calendar date in the business timezone, not UTC', () => {
    // 03:30 UTC on 2026-03-02 is still 22:30 on 2026-03-01 in Detroit
    // (EST, UTC-5).
    const instant = new Date('2026-03-02T03:30:00.000Z');
    expect(resolveBusinessDate(instant)).toBe('2026-03-01');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-03-02');
  });

  it('handles daylight-saving time (EDT, UTC-4)', () => {
    // 03:30 UTC on 2026-07-02 is 23:30 on 2026-07-01 in Detroit.
    expect(resolveBusinessDate(new Date('2026-07-02T03:30:00.000Z'))).toBe(
      '2026-07-01',
    );
    // Noon UTC is the same calendar day either way.
    expect(resolveBusinessDate(new Date('2026-07-02T12:00:00.000Z'))).toBe(
      '2026-07-02',
    );
  });

  it('is deterministic for a given instant', () => {
    const instant = new Date('2026-08-31T18:00:00.000Z');
    expect(resolveBusinessDate(instant)).toBe(resolveBusinessDate(instant));
  });

  it('round-trips through storage and projection', () => {
    const stored = businessDateToStorage('2026-08-31');
    expect(stored.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(businessDateToProjection(stored)).toBe('2026-08-31');
  });
});
