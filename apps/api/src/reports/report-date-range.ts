import { BadRequestException } from '@nestjs/common';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Milestone 9A/9B — the one place a report's date-range query params are
// validated. Narrowly focused on this one thing: a real 'YYYY-MM-DD'
// calendar date, not just regex-shaped (e.g. '2026-02-30' matches the
// regex but is not a real day). Deliberately NOT a generic report
// framework — every report still owns its own query/aggregation.
export function requireReportDate(
  value: string | undefined,
  field: string,
): string {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) {
    throw new BadRequestException(
      `${field} is required and must be a valid date in YYYY-MM-DD format.`,
    );
  }
  const [year, month, day] = value.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new BadRequestException(`${field} is not a valid calendar date.`);
  }
  return value;
}

// Validates a startDate/endDate pair together: both must be real calendar
// dates, and startDate must be on or before endDate.
export function requireReportDateRange(
  startDate: string | undefined,
  endDate: string | undefined,
): { startDate: string; endDate: string } {
  const validStart = requireReportDate(startDate, 'startDate');
  const validEnd = requireReportDate(endDate, 'endDate');
  if (validStart > validEnd) {
    throw new BadRequestException('startDate must be on or before endDate.');
  }
  return { startDate: validStart, endDate: validEnd };
}
