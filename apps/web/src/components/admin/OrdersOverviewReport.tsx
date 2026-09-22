"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AdminOrdersOverviewReport,
  OrderStatus,
} from "@mocha-house/contracts";
import {
  buildReportQuery,
  checkReportDateRange,
  type ReportFilters,
} from "@/lib/admin/reports";
import { formatPrice } from "@/lib/money";
import { Card } from "@/components/Card";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";
import { ExportCsvButton } from "./ExportCsvButton";

const ROUTE = "/admin/reports/orders";

const STATUS_LABEL: Record<OrderStatus, string> = {
  RECEIVED: "Received",
  ACCEPTED: "Accepted",
  PREPARING: "Preparing",
  READY: "Ready",
  COMPLETED: "Completed",
};

const STATUS_ORDER: OrderStatus[] = [
  "RECEIVED",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "COMPLETED",
];

// HQ Digital Sales & Orders report (Milestone 9A). Filters live entirely in
// the URL query string (mirrors AuditLogBrowser), so the view is
// refresh-safe and linkable. All money values arrive as integer minor
// units and are only ever formatted at the last step, in USD — the
// platform is single-currency today.
export function OrdersOverviewReport({
  report,
  filters,
}: {
  report: AdminOrdersOverviewReport;
  filters: ReportFilters;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<ReportFilters>(filters);
  const [error, setError] = useState<string | null>(null);

  function applyFilters() {
    const dateError = checkReportDateRange(draft.startDate, draft.endDate);
    if (dateError) {
      setError(dateError);
      return;
    }
    setError(null);
    router.push(`${ROUTE}${buildReportQuery(draft)}`);
  }

  return (
    <div className="flex flex-col gap-4">
      <Card tone="subtle" className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-text-primary">
          {report.source.scopeLabel}
        </span>
        <span className="text-text-muted">{report.source.freshnessLabel}</span>
      </Card>

      <Card className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="Start date" htmlFor="report-start-date">
            <input
              id="report-start-date"
              type="date"
              value={draft.startDate}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  startDate: event.target.value,
                }))
              }
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <FormField label="End date" htmlFor="report-end-date">
            <input
              id="report-end-date"
              type="date"
              value={draft.endDate}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  endDate: event.target.value,
                }))
              }
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <FormField label="Location" htmlFor="report-location">
            <select
              id="report-location"
              value={draft.locationId ?? ""}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  locationId:
                    event.target.value === "" ? null : event.target.value,
                }))
              }
              className={ADMIN_FIELD_CLASS}
            >
              <option value="">All locations</option>
              {report.availableLocations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-status-warning">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={applyFilters}>Apply</Button>
          {/* Uses the applied `filters` prop, never `draft` — the export
              must always correspond to the report currently on screen. */}
          <ExportCsvButton
            href={`/api/internal/admin/reports/orders-overview/export${buildReportQuery(filters)}`}
          />
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Total orders" value={String(report.totalOrders)} />
        <MetricCard
          label="Completed orders"
          value={String(report.completedOrders)}
        />
        <MetricCard
          label="Digital sales"
          value={formatPrice(report.digitalSalesMinorUnits, "USD")}
        />
        <MetricCard
          label="Average order value"
          value={formatPrice(report.averageOrderValueMinorUnits, "USD")}
        />
      </div>

      <Card className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-text-primary">
          Order status breakdown
        </h2>
        <ul className="flex flex-col gap-2">
          {STATUS_ORDER.map((status) => (
            <li
              key={status}
              className="flex items-center justify-between border-b border-border-default pb-2 text-sm last:border-b-0 last:pb-0"
            >
              <span className="text-text-secondary">
                {STATUS_LABEL[status]}
              </span>
              <span className="font-medium text-text-primary">
                {report.statusBreakdown[status]}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
        {label}
      </span>
      <span className="text-2xl font-semibold text-text-primary">
        {value}
      </span>
    </Card>
  );
}
