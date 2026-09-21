// The ONE place the Digital Sales & Orders report's (Milestone 9A)
// client-side filter vocabulary, query-string shape, default range and
// validation live. Page and island code ask questions through these
// helpers; the API re-validates everything.

// Mirrors MOCHA_HOUSE_TIME_ZONE / resolveBusinessDate in
// apps/api/src/operations/application/business-date.ts — the platform's one
// business timezone. Duplicated here (not imported — apps/web and apps/api
// share no source, only @mocha-house/contracts) so the report's default
// date range agrees with the API's own business-day semantics rather than
// drifting to the viewer's local browser timezone or UTC.
const MOCHA_HOUSE_TIME_ZONE = "America/Detroit";

// Today's business calendar date ('YYYY-MM-DD') in the platform's business
// timezone, used only as the report's default range when no filter is in
// the URL yet.
export function currentBusinessDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MOCHA_HOUSE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: "year" | "month" | "day") =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface ReportFilters {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  locationId: string | null;
}

type RawParam = string | string[] | undefined;

function firstValue(value: RawParam): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

// Turn raw URL search params into clean filters, defaulting an absent
// date to today's business date (so the report always has a valid range to
// query, even on first visit with no query string).
export function normalizeReportFilters(raw: {
  startDate?: RawParam;
  endDate?: RawParam;
  locationId?: RawParam;
}): ReportFilters {
  const today = currentBusinessDate();
  return {
    startDate: firstValue(raw.startDate) ?? today,
    endDate: firstValue(raw.endDate) ?? today,
    locationId: firstValue(raw.locationId),
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateOnly(value: string): boolean {
  if (!DATE_ONLY.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

// Validate the Start / End pair for the filter form before it's sent —
// the API re-validates independently; this just gives the viewer an
// immediate, specific message instead of a round trip to find out.
export function checkReportDateRange(
  startDate: string,
  endDate: string,
): string | null {
  if (!isValidDateOnly(startDate)) {
    return "Enter a valid start date.";
  }
  if (!isValidDateOnly(endDate)) {
    return "Enter a valid end date.";
  }
  if (startDate > endDate) {
    return "The start date must be on or before the end date.";
  }
  return null;
}

// Build the query string the read helper / API expects. `locationId` is
// omitted entirely for "All locations".
export function buildReportQuery(filters: ReportFilters): string {
  const params = new URLSearchParams();
  params.set("startDate", filters.startDate);
  params.set("endDate", filters.endDate);
  if (filters.locationId) {
    params.set("locationId", filters.locationId);
  }
  return `?${params.toString()}`;
}
