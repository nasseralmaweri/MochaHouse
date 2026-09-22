"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminLocationPerformanceReport } from "@mocha-house/contracts";
import {
  buildDateRangeQuery,
  checkReportDateRange,
  type DateRangeFilters,
} from "@/lib/admin/reports";
import { formatPrice } from "@/lib/money";
import { Card } from "@/components/Card";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";
import { ExportCsvButton } from "./ExportCsvButton";
import { AdminEmptyState } from "./states";

const ROUTE = "/admin/reports/locations";

// HQ Location Performance report (Milestone 9B). Filters live entirely in
// the URL query string (mirrors OrdersOverviewReport / AuditLogBrowser),
// so the view is refresh-safe and linkable. This is a comparison table,
// never a ranking — rows are always sorted by name, never by a metric.
export function LocationPerformanceReport({
  report,
  filters,
}: {
  report: AdminLocationPerformanceReport;
  filters: DateRangeFilters;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<DateRangeFilters>(filters);
  const [error, setError] = useState<string | null>(null);

  function applyFilters() {
    const dateError = checkReportDateRange(draft.startDate, draft.endDate);
    if (dateError) {
      setError(dateError);
      return;
    }
    setError(null);
    router.push(`${ROUTE}${buildDateRangeQuery(draft)}`);
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
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Start date" htmlFor="location-perf-start-date">
            <input
              id="location-perf-start-date"
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
          <FormField label="End date" htmlFor="location-perf-end-date">
            <input
              id="location-perf-end-date"
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
            href={`/api/internal/admin/reports/location-performance/export${buildDateRangeQuery(filters)}`}
          />
        </div>
      </Card>

      <p className="text-sm text-text-secondary">
        Completed % reflects orders whose current status is Completed.
        Orders still in progress lower this figure, so it is most
        meaningful for a period that has already ended.
      </p>

      {report.locations.length === 0 ? (
        <AdminEmptyState
          title="No locations to show"
          description="No currently active locations, and no inactive location had orders in this period."
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[48rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border-default text-left text-xs text-text-muted">
                <th className="py-2 pr-3 font-medium">Location</th>
                <th className="py-2 pr-3 text-right font-medium">
                  Total orders
                </th>
                <th className="py-2 pr-3 text-right font-medium">
                  Completed orders
                </th>
                <th className="py-2 pr-3 text-right font-medium">
                  Completed %
                </th>
                <th className="py-2 pr-3 text-right font-medium">
                  Digital sales
                </th>
                <th className="py-2 pr-3 text-right font-medium">
                  Average order value
                </th>
              </tr>
            </thead>
            <tbody>
              {report.locations.map((location) => (
                <tr
                  key={location.locationId}
                  className="border-b border-border-default/60 align-top"
                >
                  <td className="py-2 pr-3">
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium text-text-primary">
                        {location.locationName}
                      </span>
                      {!location.isActive ? (
                        <span className="text-xs text-text-muted">
                          Inactive
                        </span>
                      ) : !location.isDigitalOrderingEnabled ? (
                        <span className="text-xs text-text-muted">
                          Digital ordering disabled
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right text-text-secondary">
                    {location.totalOrders}
                  </td>
                  <td className="py-2 pr-3 text-right text-text-secondary">
                    {location.completedOrders}
                  </td>
                  <td className="py-2 pr-3 text-right text-text-secondary">
                    {location.completedPercent.toFixed(1)}%
                  </td>
                  <td className="py-2 pr-3 text-right text-text-secondary">
                    {formatPrice(location.digitalSalesMinorUnits, "USD")}
                  </td>
                  <td className="py-2 pr-3 text-right text-text-secondary">
                    {formatPrice(location.averageOrderValueMinorUnits, "USD")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
