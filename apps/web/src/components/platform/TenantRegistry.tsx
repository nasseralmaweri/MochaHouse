import Form from "next/form";
import Link from "next/link";
import type { PlatformTenantStatus } from "@mocha-house/contracts";
import {
  REGISTRY_STATE_COPY,
  TENANT_STATUS_LABELS,
  type PageWindow,
  type RegistryState,
  type TenantListFilters,
} from "@/lib/platform/tenant-registry";

// SC1c — building blocks for the tenant registry screens. The filters are a
// GET form (next/form: a client-side navigation, and a plain GET without
// JavaScript) and paging is plain links.

// Status as text with a coloured dot (the text itself stays at full
// contrast; colour is never the only signal).
export function TenantStatusBadge({ status }: { status: PlatformTenantStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-default px-2.5 py-0.5 text-xs font-medium text-text-primary">
      <span
        aria-hidden="true"
        className={`h-2 w-2 rounded-full ${
          status === "ACTIVE" ? "bg-status-success" : "bg-status-warning"
        }`}
      />
      {TENANT_STATUS_LABELS[status]}
    </span>
  );
}

export function RegistryStatePanel({
  state,
  retryHref,
}: {
  state: Exclude<RegistryState, "ok">;
  retryHref?: string;
}) {
  const copy = REGISTRY_STATE_COPY[state];
  // Everything that blocks the page is an alert; "not found" is a status.
  return (
    <div
      role={state === "not-found" ? "status" : "alert"}
      className="flex flex-col items-start gap-3 rounded-2xl border border-border-default bg-surface-card p-6"
    >
      <h2 className="text-base font-semibold text-text-primary">{copy.title}</h2>
      <p className="max-w-prose text-sm text-text-secondary">{copy.body}</p>
      {state === "session-ended" ? (
        <Link
          href="/platform/sign-in?notice=expired"
          className={SECONDARY_LINK}
        >
          Sign in again
        </Link>
      ) : state === "not-found" ? (
        <Link href="/platform/tenants" className={SECONDARY_LINK}>
          Back to tenants
        </Link>
      ) : retryHref ? (
        <Link href={retryHref} className={SECONDARY_LINK}>
          Try again
        </Link>
      ) : null}
    </div>
  );
}

const SECONDARY_LINK =
  "rounded-lg border border-border-default px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

const FIELD =
  "min-h-10 w-full rounded-lg border border-border-default bg-surface-card px-3 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

export function TenantFilters({
  filters,
  searchError,
}: {
  filters: TenantListFilters;
  searchError: string | null;
}) {
  const filtered = Boolean(filters.q || filters.status);
  return (
    <Form
      // Remounted for each filter set, so the fields always show the
      // filters in the URL (e.g. after "Clear").
      key={`${filters.q}|${filters.status}`}
      role="search"
      aria-label="Search tenants"
      action="/platform/tenants"
      className="flex flex-col gap-3 rounded-2xl border border-border-default bg-surface-card p-4 sm:flex-row sm:items-end"
    >
      <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium text-text-primary">
        Search
        <input
          type="search"
          name="q"
          defaultValue={filters.q}
          maxLength={80}
          placeholder="Business name or slug"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={searchError ? true : undefined}
          aria-describedby={searchError ? "tenant-search-error" : undefined}
          className={FIELD}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-text-primary sm:w-44">
        Status
        <select name="status" defaultValue={filters.status} className={FIELD}>
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="SUSPENDED">Suspended</option>
        </select>
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          className="min-h-10 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-contrast hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Apply
        </button>
        {filtered ? (
          <Link
            href="/platform/tenants"
            className="inline-flex min-h-10 items-center rounded-lg px-3 text-sm font-medium text-text-secondary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            Clear
          </Link>
        ) : null}
      </div>
      {searchError ? (
        <p
          id="tenant-search-error"
          role="alert"
          className="text-sm text-status-error sm:basis-full"
        >
          {searchError}
        </p>
      ) : null}
    </Form>
  );
}

export function RegistryPagination({
  paging,
  hrefFor,
  label,
}: {
  paging: PageWindow;
  hrefFor: (page: number) => string;
  label: string;
}) {
  if (paging.totalPages <= 1) return null;
  const link =
    "inline-flex min-h-10 items-center rounded-lg border border-border-default px-3 text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
  const disabled =
    "inline-flex min-h-10 items-center rounded-lg border border-border-default px-3 text-sm font-medium text-text-muted";
  return (
    <nav
      aria-label={label}
      className="flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-sm text-text-secondary">
        Page {paging.page} of {paging.totalPages}
      </p>
      <div className="flex gap-2">
        {paging.hasPrevious ? (
          <Link href={hrefFor(paging.page - 1)} className={link} rel="prev">
            Previous
          </Link>
        ) : (
          <span aria-disabled="true" className={disabled}>
            Previous
          </span>
        )}
        {paging.hasNext ? (
          <Link href={hrefFor(paging.page + 1)} className={link} rel="next">
            Next
          </Link>
        ) : (
          <span aria-disabled="true" className={disabled}>
            Next
          </span>
        )}
      </div>
    </nav>
  );
}

// Loading placeholder rows; the status region announces "Loading…".
export function RegistrySkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-2xl border border-border-default bg-surface-card p-4"
    >
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          aria-hidden="true"
          className="h-10 animate-pulse rounded-lg bg-surface-subtle motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}
