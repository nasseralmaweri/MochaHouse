"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminAuditEventSummary } from "@mocha-house/contracts";
import {
  AUDIT_ACTIVITY_OPTIONS,
  buildAuditQuery,
  checkAuditDateRange,
  EMPTY_AUDIT_FILTERS,
  type AuditFilters,
} from "@/lib/admin/audit-log";
import { Card } from "@/components/Card";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";

const ROUTE = "/admin/administration/audit";

// Administration → Activity log (Milestone 5F). Read-only. The list itself
// is rendered from data the server already authorized and shaped; this
// island only drives the URL — every filter and the cursor are query
// params, so refresh / bookmark / back all work.
export function AuditLogBrowser({
  events,
  nextCursor,
  filters,
  viewingOlder,
  filtersActive,
}: {
  events: AdminAuditEventSummary[];
  nextCursor: string | null;
  filters: AuditFilters;
  viewingOlder: boolean;
  filtersActive: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<AuditFilters>(filters);
  const [error, setError] = useState<string | null>(null);

  function go(query: string) {
    router.push(`${ROUTE}${query}`);
  }

  function applyFilters() {
    const dateError = checkAuditDateRange(draft.from, draft.to);
    if (dateError) {
      setError(dateError);
      return;
    }
    setError(null);
    // A filter change always resets pagination (no cursor).
    go(buildAuditQuery(draft));
  }

  function clearFilters() {
    setDraft(EMPTY_AUDIT_FILTERS);
    setError(null);
    go("");
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Activity" htmlFor="audit-type">
            <select
              id="audit-type"
              value={draft.type ?? ""}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  type:
                    event.target.value === ""
                      ? null
                      : (event.target
                          .value as AuditFilters["type"]),
                }))
              }
              className={ADMIN_FIELD_CLASS}
            >
              <option value="">All activity</option>
              {AUDIT_ACTIVITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Performed by" htmlFor="audit-actor">
            <input
              id="audit-actor"
              type="search"
              value={draft.actor ?? ""}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  actor: event.target.value === "" ? null : event.target.value,
                }))
              }
              placeholder="Name or email"
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <FormField label="From" htmlFor="audit-from">
            <input
              id="audit-from"
              type="date"
              value={draft.from ?? ""}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  from: event.target.value === "" ? null : event.target.value,
                }))
              }
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <FormField label="To" htmlFor="audit-to">
            <input
              id="audit-to"
              type="date"
              value={draft.to ?? ""}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  to: event.target.value === "" ? null : event.target.value,
                }))
              }
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-status-warning">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={applyFilters}>Apply filters</Button>
          {filtersActive ? (
            <Button variant="secondary" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>
      </Card>

      {viewingOlder ? (
        <button
          type="button"
          onClick={() => go(buildAuditQuery(filters))}
          className="self-start text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          ← Back to newest
        </button>
      ) : null}

      {events.length === 0 ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          {filtersActive
            ? "No activity matches these filters."
            : "No activity has been recorded yet."}
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {events.map((event) => (
            <AuditRow key={event.id} event={event} />
          ))}
        </ul>
      )}

      {nextCursor ? (
        <Button
          variant="secondary"
          onClick={() => go(buildAuditQuery(filters, nextCursor))}
          className="self-start"
        >
          Show older activity
        </Button>
      ) : null}
    </div>
  );
}

function AuditRow({ event }: { event: AdminAuditEventSummary }) {
  return (
    <li>
      <Card className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text-primary">
          {event.activityLabel}
        </span>
        <span className="text-xs text-text-muted">
          {formatWhen(event.occurredAt)} · by {event.actor.name}
          {event.location ? ` · ${event.location.name}` : ""}
        </span>
        <span className="text-sm text-text-secondary">
          Reason: {event.reason}
        </span>
        {event.details.length > 0 ? (
          <details className="text-sm text-text-secondary">
            <summary className="cursor-pointer text-text-primary">
              View details
            </summary>
            <dl className="mt-1 flex flex-col gap-0.5">
              {event.details.map((detail) => (
                <div key={detail.label} className="flex gap-2">
                  <dt className="text-text-muted">{detail.label}:</dt>
                  <dd>{detail.value}</dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
      </Card>
    </li>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
