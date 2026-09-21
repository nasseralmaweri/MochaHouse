// The one place the Mocha House business day is resolved (Milestone 6B).
// A single business timezone for the whole platform in 6B — there is
// deliberately NO Location.timeZone, no operating-hours model and no
// cutoff logic. A concrete per-location model is a later decision.
export const MOCHA_HOUSE_TIME_ZONE = 'America/Detroit';

// The calendar date at `instant` in the business timezone, as
// 'YYYY-MM-DD'. Uses the runtime's built-in Intl timezone database — no
// date/time dependency is introduced for this. 'en-CA' formats as
// ISO-style year-month-day, which we assemble explicitly rather than
// trust the locale's separator.
export function resolveBusinessDate(
  instant: Date,
  timeZone: string = MOCHA_HOUSE_TIME_ZONE,
): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const get = (type: 'year' | 'month' | 'day'): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) {
      throw new Error(`Could not resolve business date part "${type}".`);
    }
    return part.value;
  };

  return `${get('year')}-${get('month')}-${get('day')}`;
}

// The value to persist in / query against ChecklistInstance.businessDate
// (Prisma `@db.Date` — only the date component is stored). Midnight UTC on
// the business calendar date is a stable, deterministic representation.
export function businessDateToStorage(businessDate: string): Date {
  return new Date(`${businessDate}T00:00:00.000Z`);
}

// The inverse — a stored `@db.Date` value back to 'YYYY-MM-DD' for the API
// projection.
export function businessDateToProjection(stored: Date): string {
  return stored.toISOString().slice(0, 10);
}

// Milestone 9A — reporting needs to filter a real DateTime column
// (Order.createdAt) by business calendar day, which `businessDateToStorage`
// above does NOT do: it stores a `@db.Date` value at UTC midnight, which is
// only correct because Postgres DATE has no time component to get wrong.
// Filtering createdAt instead needs the actual UTC instant of local
// midnight in `timeZone`. US DST transitions happen at 2am local time, never
// at midnight, so local midnight is never skipped or duplicated — a single
// offset correction (no fixed-point iteration) is exact here.
function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) {
      throw new Error(`Could not resolve time zone part "${type}".`);
    }
    return Number(part.value);
  };

  // The wall-clock reading of `instant` in `timeZone`, reinterpreted as if
  // it were itself a UTC instant, minus the real instant — i.e. the zone's
  // current UTC offset in milliseconds (negative west of UTC).
  const wallClockAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wallClockAsUtc - instant.getTime();
}

// The UTC instant of local midnight at the START of `businessDate` in
// `timeZone`.
export function businessDateStartInstant(
  businessDate: string,
  timeZone: string = MOCHA_HOUSE_TIME_ZONE,
): Date {
  const naiveUtcMidnight = new Date(`${businessDate}T00:00:00.000Z`);
  const offsetMs = timeZoneOffsetMs(naiveUtcMidnight, timeZone);
  return new Date(naiveUtcMidnight.getTime() - offsetMs);
}

// Pure calendar-date arithmetic on the 'YYYY-MM-DD' string — never
// reinterpreted as a wall-clock time in any zone, so this is safe
// regardless of DST.
function addCalendarDays(dateOnly: string, days: number): string {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const scratch = new Date(Date.UTC(year, month - 1, day));
  scratch.setUTCDate(scratch.getUTCDate() + days);
  return scratch.toISOString().slice(0, 10);
}

// The UTC instant range [start, endExclusive) covering every instant that
// falls on a business calendar day from `startDate` through `endDate`
// (both inclusive) in `timeZone`. Intended for `createdAt: { gte: start, lt:
// endExclusive }` style Prisma filters — never an inclusive upper bound,
// which would risk off-by-one double-counting the first instant of the next
// business day.
export function businessDateRangeToUtcInstants(
  startDate: string,
  endDate: string,
  timeZone: string = MOCHA_HOUSE_TIME_ZONE,
): { start: Date; endExclusive: Date } {
  return {
    start: businessDateStartInstant(startDate, timeZone),
    endExclusive: businessDateStartInstant(
      addCalendarDays(endDate, 1),
      timeZone,
    ),
  };
}
