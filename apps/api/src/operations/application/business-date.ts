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
