import type {
  AdminLocationPerformanceRow,
  AdminOperationsChecklistRow,
  LocationSummary,
  OperationsTasksResponse,
  StoreOrderSummary,
} from "@mocha-house/contracts";
import type { AttentionItem } from "./attention";
import type { AdminLocationContext } from "./location-context";

// Pure view-model logic for the CENTERIVO Overview. Framework-free like the
// rest of lib/admin: it makes NO authorization decision (every read the page
// performs is independently guarded server-side) and computes NO metric —
// it only arranges figures the API already returned.

// --- Scope -----------------------------------------------------------------
// Business -> Scope -> Work. Scope is Company-wide or one location.
export type OverviewScope =
  | { kind: "company" }
  | { kind: "location"; location: LocationSummary }
  | { kind: "forbidden"; requestedId: string }
  | { kind: "none" };

export function resolveOverviewScope(
  context: AdminLocationContext,
): OverviewScope {
  switch (context.kind) {
    case "corporate":
      return { kind: "company" };
    case "location":
      return { kind: "location", location: context.location };
    case "forbidden":
      return { kind: "forbidden", requestedId: context.requestedId };
    case "none":
      return { kind: "none" };
  }
}

// --- Business calendar -----------------------------------------------------
// The reports use America/Detroit business dates (the API hard-codes the
// same zone), so "today" here must be that zone's calendar date, not the
// browser's or server's.
export const OVERVIEW_TIME_ZONE = "America/Detroit";

export type OverviewRange = "today" | "7d" | "30d";

export const OVERVIEW_RANGES: ReadonlyArray<{
  value: OverviewRange;
  label: string;
  days: number;
}> = [
  { value: "today", label: "Today", days: 1 },
  { value: "7d", label: "7 days", days: 7 },
  { value: "30d", label: "30 days", days: 30 },
];

export function parseOverviewRange(
  raw: string | null | undefined,
): OverviewRange {
  return OVERVIEW_RANGES.some((r) => r.value === raw)
    ? (raw as OverviewRange)
    : "today";
}

// YYYY-MM-DD in the business time zone.
export function businessToday(
  now: Date,
  timeZone: string = OVERVIEW_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const result = new Date(Date.UTC(y, m - 1, d + days));
  return result.toISOString().slice(0, 10);
}

export function rangeDates(
  range: OverviewRange,
  today: string,
): { startDate: string; endDate: string } {
  const days = OVERVIEW_RANGES.find((r) => r.value === range)?.days ?? 1;
  return { startDate: addDays(today, -(days - 1)), endDate: today };
}

// "Wednesday, October 7" for a YYYY-MM-DD business date.
export function formatBusinessDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

// --- Attention items -------------------------------------------------------
// Lists return one page; a `nextCursor` means "at least this many".
function countText(count: number, hasMore: boolean): string {
  return hasMore ? `${count}+` : String(count);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function approvalsAttention(
  count: number,
  hasMore: boolean,
): AttentionItem | null {
  if (count === 0) return null;
  return {
    id: "approvals-pending",
    severity: "warning",
    title: `${countText(count, hasMore)} ${plural(count, "approval request is", "approval requests are")} waiting`,
    description: "A decision is needed before the request can move forward.",
    context: "Company",
    href: "/admin/approvals",
    actionLabel: "Review",
  };
}

export function applicantsAttention(
  count: number,
  hasMore: boolean,
): AttentionItem | null {
  if (count === 0) return null;
  return {
    id: "applicants-new",
    severity: "info",
    title: `${countText(count, hasMore)} new job ${plural(count, "applicant", "applicants")}`,
    description: "Applications that haven't been reviewed yet.",
    context: "Company",
    href: "/admin/careers/applicants",
    actionLabel: "Review",
  };
}

export function inquiriesAttention(
  count: number,
  hasMore: boolean,
): AttentionItem | null {
  if (count === 0) return null;
  return {
    id: "franchise-inquiries-new",
    severity: "info",
    title: `${countText(count, hasMore)} new franchise ${plural(count, "inquiry", "inquiries")}`,
    description: "Inquiries that haven't been reviewed yet.",
    context: "Company",
    href: "/admin/franchising",
    actionLabel: "Review",
  };
}

// Today's CURRENT checklist exceptions (a live-state count, not a history —
// the report contract says so). `onlyLocationId` narrows to one location.
export function checklistExceptionAttention(
  rows: readonly AdminOperationsChecklistRow[],
  onlyLocationId: string | null,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const row of rows) {
    if (onlyLocationId !== null && row.locationId !== onlyLocationId) continue;
    const total = row.openingCurrentExceptions + row.closingCurrentExceptions;
    if (total === 0) continue;
    const parts: string[] = [];
    if (row.openingCurrentExceptions > 0) {
      parts.push(`Opening: ${row.openingCurrentExceptions}`);
    }
    if (row.closingCurrentExceptions > 0) {
      parts.push(`Closing: ${row.closingCurrentExceptions}`);
    }
    items.push({
      id: `checklist-exceptions-${row.locationId}`,
      severity: "warning",
      title: `${total} checklist ${plural(total, "exception", "exceptions")} logged today`,
      description: parts.join(" · "),
      context: row.locationName,
      href: `/admin/operations?location=${encodeURIComponent(row.locationId)}`,
      actionLabel: "Open operations",
    });
  }
  return items;
}

export function openTasksAttention(
  location: LocationSummary,
  tasks: Pick<OperationsTasksResponse, "openCount">,
): AttentionItem | null {
  if (tasks.openCount === 0) return null;
  return {
    id: `open-tasks-${location.id}`,
    severity: "info",
    title: `${tasks.openCount} open ${plural(tasks.openCount, "task", "tasks")} today`,
    description: "Tasks added for today that haven't been completed.",
    context: location.name,
    href: `/admin/operations?location=${encodeURIComponent(location.id)}`,
    actionLabel: "Open operations",
  };
}

// Orders still in RECEIVED have not been accepted by the store. No age
// threshold is invented — this is just the count.
export function waitingOrdersAttention(
  location: LocationSummary,
  orders: readonly Pick<StoreOrderSummary, "status">[],
): AttentionItem | null {
  const waiting = orders.filter((o) => o.status === "RECEIVED").length;
  if (waiting === 0) return null;
  return {
    id: `orders-waiting-${location.id}`,
    severity: "warning",
    title: `${waiting} new ${plural(waiting, "order is", "orders are")} waiting to be accepted`,
    description: "Customers are waiting for the store to accept their order.",
    context: location.name,
    href: `/admin/orders?location=${encodeURIComponent(location.id)}`,
    actionLabel: "Open orders",
  };
}

// Warnings first; otherwise the caller's order is preserved.
export function prioritizeAttention(items: AttentionItem[]): AttentionItem[] {
  const rank = (item: AttentionItem) => (item.severity === "warning" ? 0 : 1);
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

// --- Location comparison ---------------------------------------------------
// Opening/closing state for TODAY, from the read-only checklist report. An
// instance exists only once someone opened the checklist, so "not recorded"
// means no activity was recorded — never that the checklist was missed.
export type ChecklistState = "completed" | "in-progress" | "not-recorded";

export function checklistState(
  started: number,
  completed: number,
): ChecklistState {
  if (started === 0) return "not-recorded";
  return completed >= started ? "completed" : "in-progress";
}

export interface OverviewLocationRow {
  locationId: string;
  name: string;
  isActive: boolean;
  isDigitalOrderingEnabled: boolean;
  orders: number;
  completedOrders: number;
  salesMinorUnits: number;
  averageOrderMinorUnits: number;
  checklist: {
    opening: ChecklistState;
    closing: ChecklistState;
    exceptions: number;
  } | null;
  // Plain-language reasons this location deserves a look. Always rendered as
  // text, never colour alone.
  flags: string[];
}

export function buildLocationRows(
  performance: readonly AdminLocationPerformanceRow[],
  checklist: readonly AdminOperationsChecklistRow[] | null,
): OverviewLocationRow[] {
  const byLocation = new Map(checklist?.map((row) => [row.locationId, row]));
  const rows = performance.map<OverviewLocationRow>((row) => {
    const c = byLocation.get(row.locationId) ?? null;
    const exceptions = c
      ? c.openingCurrentExceptions + c.closingCurrentExceptions
      : 0;
    const flags: string[] = [];
    if (row.isActive && !row.isDigitalOrderingEnabled) {
      flags.push("Online ordering off");
    }
    if (exceptions > 0) {
      flags.push(
        `${exceptions} checklist ${plural(exceptions, "exception", "exceptions")}`,
      );
    }
    return {
      locationId: row.locationId,
      name: row.locationName,
      isActive: row.isActive,
      isDigitalOrderingEnabled: row.isDigitalOrderingEnabled,
      orders: row.totalOrders,
      completedOrders: row.completedOrders,
      salesMinorUnits: row.digitalSalesMinorUnits,
      averageOrderMinorUnits: row.averageOrderValueMinorUnits,
      checklist: c
        ? {
            opening: checklistState(c.openingStarted, c.openingCompleted),
            closing: checklistState(c.closingStarted, c.closingCompleted),
            exceptions,
          }
        : null,
      flags,
    };
  });
  // Locations needing a look first (this table is for finding them), then by
  // name. Never sorted by a sales metric — it is not a ranking.
  return rows.sort(
    (a, b) =>
      Number(b.flags.length > 0) - Number(a.flags.length > 0) ||
      a.name.localeCompare(b.name),
  );
}

// "Today" or "Last 7 days · Oct 1 – Oct 7" — the period named in plain words
// next to the figures it applies to.
export function describeRange(range: OverviewRange, today: string): string {
  if (range === "today") return "Today";
  const { startDate, endDate } = rangeDates(range, today);
  const short = (date: string) => {
    const [y, m, d] = date.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    }).format(new Date(Date.UTC(y, m - 1, d)));
  };
  const days = OVERVIEW_RANGES.find((r) => r.value === range)?.days ?? 1;
  return `Last ${days} days · ${short(startDate)} – ${short(endDate)}`;
}

// Inside a page already scoped to a location (and a shell that names the
// business), "Mocha House - Dearborn Heights" reads better as "Dearborn
// Heights". Strips a leading "<business> - " (hyphen, en/em dash or colon);
// anything else is returned unchanged.
export function shortLocationName(
  locationName: string,
  businessName: string,
): string {
  const escaped = businessName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = locationName.replace(
    new RegExp(`^${escaped}\\s*[-–—:]\\s*`, "i"),
    "",
  );
  return stripped.trim().length > 0 ? stripped : locationName;
}
