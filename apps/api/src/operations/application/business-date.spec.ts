import {
  MOCHA_HOUSE_TIME_ZONE,
  businessDateRangeToUtcInstants,
  businessDateStartInstant,
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

  // --- Milestone 9A: business-day instant boundaries (createdAt filters) ---

  it('businessDateStartInstant resolves local midnight in EST (UTC-5)', () => {
    expect(businessDateStartInstant('2026-01-15').toISOString()).toBe(
      '2026-01-15T05:00:00.000Z',
    );
  });

  it('businessDateStartInstant resolves local midnight in EDT (UTC-4)', () => {
    expect(businessDateStartInstant('2026-07-01').toISOString()).toBe(
      '2026-07-01T04:00:00.000Z',
    );
  });

  it('adapts per-day across the spring-forward DST transition (2026-03-08)', () => {
    // 2am local on 2026-03-08 is when Detroit springs forward, so midnight
    // that same day is still EST — the transition never touches midnight.
    expect(businessDateStartInstant('2026-03-08').toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
    expect(businessDateStartInstant('2026-03-09').toISOString()).toBe(
      '2026-03-09T04:00:00.000Z',
    );
  });

  it('round-trips: the computed instant resolves back to the same business date', () => {
    for (const date of ['2026-01-15', '2026-03-08', '2026-03-09', '2026-07-01']) {
      expect(resolveBusinessDate(businessDateStartInstant(date))).toBe(date);
    }
  });

  it('accepts an explicit alternate time zone', () => {
    expect(businessDateStartInstant('2026-06-01', 'UTC').toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('businessDateRangeToUtcInstants covers [start of startDate, start of the day AFTER endDate)', () => {
    const { start, endExclusive } = businessDateRangeToUtcInstants(
      '2026-09-01',
      '2026-09-07',
    );
    expect(start.toISOString()).toBe('2026-09-01T04:00:00.000Z');
    // endExclusive is the start of 2026-09-08, NOT 2026-09-07 — an
    // inclusive endDate must still exclude the following day's first
    // instant, never double-count it.
    expect(endExclusive.toISOString()).toBe('2026-09-08T04:00:00.000Z');
  });

  it('a single-day range covers exactly one 24-hour business day', () => {
    const { start, endExclusive } = businessDateRangeToUtcInstants(
      '2026-09-01',
      '2026-09-01',
    );
    expect(endExclusive.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
