"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminOperationsChecklistReport } from "@mocha-house/contracts";
import {
  buildDateRangeQuery,
  checkReportDateRange,
  type DateRangeFilters,
} from "@/lib/admin/reports";
import { Card } from "@/components/Card";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";

const ROUTE = "/admin/reports/operations";

// HQ Operations Checklist Visibility report (Milestone 9C). Filters live
// entirely in the URL query string (mirrors OrdersOverviewReport /
// LocationPerformanceReport). This is OPERATIONS VISIBILITY, not
// compliance scoring — the two caveats below are load-bearing, not
// decoration, and are shown as plain text, never only in a tooltip.
export function OperationsChecklistReport({
  report,
  filters,
}: {
  report: AdminOperationsChecklistReport;
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
          <FormField label="Start date" htmlFor="ops-checklist-start-date">
            <input
              id="ops-checklist-start-date"
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
          <FormField label="End date" htmlFor="ops-checklist-end-date">
            <input
              id="ops-checklist-end-date"
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
        <div>
          <Button onClick={applyFilters}>Apply</Button>
        </div>
      </Card>

      <div className="flex flex-col gap-2 text-sm text-text-secondary">
        <p>
          Checklist instances are created when staff access a checklist. No
          recorded activity does not necessarily mean a checklist was
          missed.
        </p>
        <p>
          Current Exceptions reflects exceptions still recorded on
          checklist items. Exceptions that were later cleared are not
          included.
        </p>
      </div>

      {report.locations.length === 0 ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          No locations to show for this period.
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[56rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border-default text-left text-xs text-text-muted">
                <th className="py-2 pr-3 font-medium">Location</th>
                <th className="py-2 pr-3 text-right font-medium">
                  Opening Started
                </th>
                <th className="py-2 pr-3 text-right font-medium">
                  Opening Completed
                </th>
                <th className="py-2 pr-3 text-right font-medium">
                  Opening Current Exceptions
                </th>
                <th className="py-2 pr-3 text-right font-medium">
                  Closing Started
                </th>
                <th className="py-2 pr-3 text-right font-medium">
                  Closing Completed
                </th>
                <th className="py-2 pr-3 text-right font-medium">
                  Closing Current Exceptions
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
                      ) : null}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right text-text-secondary">
                    {location.openingStarted}
                  </td>
                  <td className="py-2 pr-3 text-right text-text-secondary">
                    {location.openingCompleted}
                  </td>
                  <td className="py-2 pr-3 text-right text-text-secondary">
                    {location.openingCurrentExceptions}
                  </td>
                  <td className="py-2 pr-3 text-right text-text-secondary">
                    {location.closingStarted}
                  </td>
                  <td className="py-2 pr-3 text-right text-text-secondary">
                    {location.closingCompleted}
                  </td>
                  <td className="py-2 pr-3 text-right text-text-secondary">
                    {location.closingCurrentExceptions}
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
