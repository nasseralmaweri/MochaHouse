import type {
  AdminAuditActivityType,
  AdminAuditFilterOptions,
} from "@mocha-house/contracts";

// The ONE place the Activity log's client-side filter vocabulary,
// query-string shape, and validation live (Milestone 5F). Page and island
// code ask questions through these helpers; the API re-validates
// everything.

export const AUDIT_ACTIVITY_OPTIONS: AdminAuditFilterOptions["activityTypes"] =
  [
    {
      value: "admin_access_status_changed",
      label: "Admin access status changed",
    },
    { value: "admin_access_granted", label: "Admin access granted" },
    { value: "admin_access_removed", label: "Admin access removed" },
  ];

// The label for the "no filter" choice.
export const AUDIT_ACTIVITY_ANY_LABEL = "All activity";

const ACTIVITY_VALUES = new Set<string>(
  AUDIT_ACTIVITY_OPTIONS.map((option) => option.value),
);

export function isAuditActivityType(
  value: string,
): value is AdminAuditActivityType {
  return ACTIVITY_VALUES.has(value);
}

export function activityTypeLabel(value: string | null): string {
  if (!value) {
    return AUDIT_ACTIVITY_ANY_LABEL;
  }
  return (
    AUDIT_ACTIVITY_OPTIONS.find((option) => option.value === value)?.label ??
    AUDIT_ACTIVITY_ANY_LABEL
  );
}

export interface AuditFilters {
  type: AdminAuditActivityType | null;
  from: string | null; // YYYY-MM-DD
  to: string | null; // YYYY-MM-DD
  actor: string | null;
}

export const EMPTY_AUDIT_FILTERS: AuditFilters = {
  type: null,
  from: null,
  to: null,
  actor: null,
};

type RawParam = string | string[] | undefined;

function firstValue(value: RawParam): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

// Turn raw URL search params into clean filters. An unrecognised activity
// type is dropped (not an error) so a hand-edited URL never breaks the page.
export function normalizeAuditFilters(raw: {
  type?: RawParam;
  from?: RawParam;
  to?: RawParam;
  actor?: RawParam;
}): AuditFilters {
  const typeRaw = firstValue(raw.type);
  return {
    type: typeRaw && isAuditActivityType(typeRaw) ? typeRaw : null,
    from: firstValue(raw.from),
    to: firstValue(raw.to),
    actor: firstValue(raw.actor),
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateOnly(value: string): boolean {
  if (!DATE_ONLY.test(value)) {
    return false;
  }
  return !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime());
}

// Validate the From / To pair for the filter form. Returns a business-safe
// error message, or null when the range is acceptable (including when both
// are empty).
export function checkAuditDateRange(
  from: string | null,
  to: string | null,
): string | null {
  if (from && !isValidDateOnly(from)) {
    return "Enter a valid From date.";
  }
  if (to && !isValidDateOnly(to)) {
    return "Enter a valid To date.";
  }
  if (from && to && from > to) {
    return "The From date must be on or before the To date.";
  }
  return null;
}

// Build the query string the read helper / API expects. Empty filter values
// are dropped. `cursor` is appended ONLY when explicitly provided — a filter
// change or "Back to newest" omits it, which resets pagination.
export function buildAuditQuery(
  filters: AuditFilters,
  cursor?: string | null,
): string {
  const params = new URLSearchParams();
  if (filters.type) {
    params.set("type", filters.type);
  }
  if (filters.from) {
    params.set("from", filters.from);
  }
  if (filters.to) {
    params.set("to", filters.to);
  }
  if (filters.actor) {
    params.set("actor", filters.actor);
  }
  if (cursor) {
    params.set("cursor", cursor);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function hasActiveAuditFilters(filters: AuditFilters): boolean {
  return Boolean(
    filters.type || filters.from || filters.to || filters.actor,
  );
}
