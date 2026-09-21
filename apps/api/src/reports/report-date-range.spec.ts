import { BadRequestException } from '@nestjs/common';
import { requireReportDate, requireReportDateRange } from './report-date-range';

// Milestone 9A/9B — the shared report date-range validation, extracted out
// of OrdersOverviewReportService in 9B so LocationPerformanceReportService
// can reuse it without copy-pasting. This spec is what proves the
// extraction changed nothing: every case 9A's controller-level tests
// already covered via HTTP (admin-reports.spec.ts) is re-asserted here
// directly against the pure function.
describe('requireReportDate (Milestone 9A/9B)', () => {
  it('accepts a real calendar date', () => {
    expect(requireReportDate('2026-09-15', 'startDate')).toBe('2026-09-15');
  });

  it('rejects a missing value', () => {
    expect(() => requireReportDate(undefined, 'startDate')).toThrow(
      BadRequestException,
    );
  });

  it('rejects a malformed date', () => {
    expect(() => requireReportDate('09/15/2026', 'startDate')).toThrow(
      BadRequestException,
    );
  });

  it('rejects an impossible calendar date that still matches the regex', () => {
    expect(() => requireReportDate('2026-02-30', 'startDate')).toThrow(
      BadRequestException,
    );
  });

  it('includes the field name in the error message', () => {
    expect(() => requireReportDate(undefined, 'endDate')).toThrow(/endDate/);
  });
});

describe('requireReportDateRange (Milestone 9A/9B)', () => {
  it('accepts a valid ordered range', () => {
    expect(requireReportDateRange('2026-09-01', '2026-09-07')).toEqual({
      startDate: '2026-09-01',
      endDate: '2026-09-07',
    });
  });

  it('accepts a single-day range (start === end)', () => {
    expect(requireReportDateRange('2026-09-01', '2026-09-01')).toEqual({
      startDate: '2026-09-01',
      endDate: '2026-09-01',
    });
  });

  it('rejects startDate after endDate', () => {
    expect(() =>
      requireReportDateRange('2026-09-10', '2026-09-01'),
    ).toThrow(BadRequestException);
  });

  it('rejects a missing startDate', () => {
    expect(() =>
      requireReportDateRange(undefined, '2026-09-01'),
    ).toThrow(BadRequestException);
  });

  it('rejects a missing endDate', () => {
    expect(() =>
      requireReportDateRange('2026-09-01', undefined),
    ).toThrow(BadRequestException);
  });
});
