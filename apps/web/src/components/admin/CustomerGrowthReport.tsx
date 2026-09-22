"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminCustomerGrowthReport } from "@mocha-house/contracts";
import {
  buildDateRangeQuery,
  checkReportDateRange,
  type DateRangeFilters,
} from "@/lib/admin/reports";
import { Card } from "@/components/Card";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";
import { ExportCsvButton } from "./ExportCsvButton";

const ROUTE = "/admin/reports/customers";

// HQ Customer Growth & Ordering report (Milestone 9D). Filters live
// entirely in the URL query string (mirrors the other three reports).
// This is customer-base SIZE and digital-ordering PARTICIPATION during a
// period — never retention, churn, conversion, or lifetime value, and the
// two caveats below are shown as plain text, not only in a tooltip.
export function CustomerGrowthReport({
  report,
  filters,
}: {
  report: AdminCustomerGrowthReport;
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
          <FormField label="Start date" htmlFor="customer-growth-start-date">
            <input
              id="customer-growth-start-date"
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
          <FormField label="End date" htmlFor="customer-growth-end-date">
            <input
              id="customer-growth-end-date"
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
            href={`/api/internal/admin/reports/customer-growth/export${buildDateRangeQuery(filters)}`}
          />
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          label="Registered customers as of end date"
          value={String(report.registeredCustomersAsOfEndDate)}
        />
        <MetricCard
          label="New registered customers"
          value={String(report.newRegisteredCustomers)}
        />
        <MetricCard
          label="Registered customers with orders"
          value={String(report.registeredCustomersWithOrders)}
        />
        <MetricCard
          label="Repeat registered customers"
          value={String(report.repeatRegisteredCustomers)}
        />
        <MetricCard
          label="Registered customer orders"
          value={String(report.registeredCustomerOrders)}
        />
        <MetricCard
          label="Guest orders"
          value={String(report.guestOrders)}
        />
      </div>

      <div className="flex flex-col gap-2 text-sm text-text-secondary">
        <p>
          Repeat Registered Customers means registered customers with two
          or more digital orders during the selected period — not a
          second lifetime purchase or a returning customer from a prior
          period.
        </p>
        <p>
          Order-based figures include digital-platform orders only.
          In-store/POS transactions are not included.
        </p>
      </div>
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
