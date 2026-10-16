import type {
  PlatformTenantStatus,
  PlatformTenantSuspensionReason,
} from "@mocha-house/contracts";

// SC1c — the tenant registry screens' pure logic: reading the page's query
// string (the same bounds the API enforces, so a hand-edited URL shows a
// clear message instead of an API error), building links, paging, labels,
// and turning an API status into a screen state. No data is invented here.

export const TENANT_PAGE_SIZE = 20;
export const LOCATION_PAGE_SIZE = 20;
const PAGE_MAX = 1_000;
const SEARCH_MAX = 80;
const SEARCH_PATTERN = /^[\p{L}\p{N} '&.,-]+$/u;
const STATUSES: readonly PlatformTenantStatus[] = ["ACTIVE", "SUSPENDED"];

type RawParams = Record<string, string | string[] | undefined>;

export interface TenantListFilters {
  q: string;
  status: PlatformTenantStatus | "";
  page: number;
}

export interface ParsedTenantListFilters {
  filters: TenantListFilters;
  // A search the API would refuse: shown as a message, never sent.
  searchError: string | null;
}

function first(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export function parsePage(raw: string | string[] | undefined): number {
  const value = first(raw);
  if (!/^[1-9][0-9]{0,4}$/.test(value)) return 1;
  return Math.min(Number(value), PAGE_MAX);
}

export function parseTenantListFilters(params: RawParams): ParsedTenantListFilters {
  const q = first(params.q).trim().replace(/\s+/g, " ");
  const rawStatus = first(params.status);
  const status = STATUSES.includes(rawStatus as PlatformTenantStatus)
    ? (rawStatus as PlatformTenantStatus)
    : "";
  let searchError: string | null = null;
  if (q.length > SEARCH_MAX) {
    searchError = `Search for ${SEARCH_MAX} characters or fewer.`;
  } else if (q.length > 0 && !SEARCH_PATTERN.test(q)) {
    searchError =
      "Search with letters, numbers, spaces and - ' & . , only.";
  }
  return { filters: { q, status, page: parsePage(params.page) }, searchError };
}

// The API query for these filters (only what is set).
export function tenantListQuery(filters: TenantListFilters): string {
  const query = new URLSearchParams();
  if (filters.q) query.set("q", filters.q);
  if (filters.status) query.set("status", filters.status);
  if (filters.page > 1) query.set("page", String(filters.page));
  query.set("pageSize", String(TENANT_PAGE_SIZE));
  return query.toString();
}

// A link to the list with these filters (page 1 is the bare URL).
export function tenantListHref(filters: Partial<TenantListFilters>): string {
  const query = new URLSearchParams();
  if (filters.q) query.set("q", filters.q);
  if (filters.status) query.set("status", filters.status);
  if (filters.page && filters.page > 1) query.set("page", String(filters.page));
  const text = query.toString();
  return text ? `/platform/tenants?${text}` : "/platform/tenants";
}

export interface PageWindow {
  page: number;
  totalPages: number;
  from: number;
  to: number;
  total: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export function pageWindow(page: number, pageSize: number, total: number): PageWindow {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : Math.min((page - 1) * pageSize + 1, total + 1);
  const to = Math.min(page * pageSize, total);
  return {
    page,
    totalPages,
    from,
    to,
    total,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
  };
}

export const TENANT_STATUS_LABELS: Record<PlatformTenantStatus, string> = {
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
};

export const SUSPENSION_REASON_LABELS: Record<
  PlatformTenantSuspensionReason,
  string
> = {
  SECURITY: "Security",
  BILLING: "Billing",
  REQUESTED: "Requested by the business",
};

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatRegistryDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : DATE_FORMAT.format(date);
}

// How a registry API answer is shown. 401 means the session ended (sign in
// again); 403 is access denied; 404 is "not found"; anything else that is
// not a 200 is "unavailable" — never a provider or server detail.
export type RegistryState =
  | "ok"
  | "session-ended"
  | "access-denied"
  | "not-found"
  | "invalid"
  | "unavailable";

export function registryStateFromStatus(status: number | null): RegistryState {
  switch (status) {
    case 200:
      return "ok";
    case 401:
      return "session-ended";
    case 403:
      return "access-denied";
    case 404:
      return "not-found";
    case 400:
      return "invalid";
    default:
      return "unavailable";
  }
}

const TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTenantId(value: string): boolean {
  return TENANT_ID_PATTERN.test(value);
}

// What each non-ok state tells the operator: plain words, never a server or
// provider detail.
export const REGISTRY_STATE_COPY: Record<
  Exclude<RegistryState, "ok">,
  { title: string; body: string }
> = {
  "session-ended": {
    title: "Your session has ended",
    body: "Sign in again to continue.",
  },
  "access-denied": {
    title: "Access denied",
    body: "This account is not permitted to view the tenant registry.",
  },
  "not-found": {
    title: "Tenant not found",
    body: "No business on CENTERIVO has this identifier.",
  },
  invalid: {
    title: "That request could not be read",
    body: "Check the search and filters, then try again.",
  },
  unavailable: {
    title: "The tenant registry is unavailable",
    body: "It could not be loaded right now. Nothing is shown rather than out-of-date data. Try again in a moment.",
  },
};

// Which empty state the list shows (an empty page is never "no businesses"
// when the registry has some).
export type EmptyListKind = "no-matches" | "past-last-page" | "no-businesses";

export function emptyListKind(filtered: boolean, total: number): EmptyListKind {
  if (filtered) return "no-matches";
  return total > 0 ? "past-last-page" : "no-businesses";
}
