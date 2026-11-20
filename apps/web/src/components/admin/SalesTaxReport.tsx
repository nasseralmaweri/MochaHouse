"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  SalesTaxReportComponent,
  SalesTaxReportResponse,
} from "@mocha-house/contracts";
import {
  buildReportQuery,
  checkReportDateRange,
  type ReportFilters,
} from "@/lib/admin/reports";
import {
  SALES_TAX_REPORT_SCOPE,
  netTaxLabel,
  taxRefundKindLabel,
  taxRefundStatusView,
} from "@/lib/admin/sales-tax-report";
import { formatPrice } from "@/lib/money";
import { Card } from "@/components/Card";
import { ADMIN_FIELD_CLASS, FormField } from "./form";
import { Button } from "./Button";
import { ExportCsvButton } from "./ExportCsvButton";
import { StatusBadge } from "./StatusBadge";

const ROUTE = "/admin/reports/sales-tax";

// V1 Sales Tax PR 3 — the sales tax report. Every figure is the server's
// (integer minor units). Net tax is withheld while refunds in the period
// have no tax attribution, so a misleading number is never shown.
export function SalesTaxReport({
  report,
  filters,
}: {
  report: SalesTaxReportResponse;
  filters: ReportFilters;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<ReportFilters>(filters);
  const [error, setError] = useState<string | null>(null);
  const currency = report.currency;
  const money = (v: number) => formatPrice(v, currency);
  const t = report.totals;

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
      <Card tone="subtle" className="text-sm text-text-secondary">
        {SALES_TAX_REPORT_SCOPE}
      </Card>

      <Card className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="Start date" htmlFor="tax-start-date">
            <input
              id="tax-start-date"
              type="date"
              value={draft.startDate}
              onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <FormField label="End date" htmlFor="tax-end-date">
            <input
              id="tax-end-date"
              type="date"
              value={draft.endDate}
              onChange={(e) => setDraft({ ...draft, endDate: e.target.value })}
              className={ADMIN_FIELD_CLASS}
            />
          </FormField>
          <FormField label="Location" htmlFor="tax-location">
            <select
              id="tax-location"
              value={draft.locationId ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, locationId: e.target.value || null })
              }
              className={ADMIN_FIELD_CLASS}
            >
              <option value="">All locations</option>
              {report.availableLocations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
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
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={applyFilters}>Apply</Button>
          <ExportCsvButton
            href={`/api/internal/admin/reports/sales-tax/export${buildReportQuery(filters)}`}
          />
        </div>
      </Card>

      {report.unattributedRefunds > 0 ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          <p role="alert">
            <strong>Net tax is not final.</strong> {report.unattributedRefunds} refund
            {report.unattributedRefunds === 1 ? "" : "s"} totalling{" "}
            {money(report.unattributedRefundMinorUnits)} {report.unattributedRefunds === 1 ? "has" : "have"}{" "}
            no tax attribution (an amount refund of a taxed order). How much of
            {report.unattributedRefunds === 1 ? " it" : " them"} was sales tax is not known
            and is not assumed. They are listed below.
          </p>
        </Card>
      ) : null}

      <Card className="flex flex-col gap-3">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
          <Figure label="Taxable sales" value={money(t.taxableSalesMinorUnits)} />
          <Figure label="Tax collected" value={money(t.taxCollectedMinorUnits)} />
          <Figure label="Tax refunded" value={money(t.taxRefundedMinorUnits)} />
          <Figure
            label="Net tax"
            value={netTaxLabel(t.netTaxMinorUnits, currency)}
            strong
            warning={t.netTaxMinorUnits === null}
          />
          <Figure label="Taxed orders" value={String(t.orders)} />
          <Figure label="Net sales" value={money(t.netSalesMinorUnits)} />
          <Figure label="Exempt sales" value={money(t.exemptSalesMinorUnits)} />
          <Figure
            label="Refunds pending"
            value={money(report.pendingTaxRefundMinorUnits)}
          />
        </dl>
      </Card>

      <Components title="By tax" components={report.components} money={money} currency={currency} />

      {report.locations.length > 1 || !report.locationId ? (
        <Card className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-text-primary">By location</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="text-xs text-text-secondary">
                <tr>
                  <th className="py-1 pr-3 font-medium">Location</th>
                  <th className="py-1 pr-3 font-medium">Taxable sales</th>
                  <th className="py-1 pr-3 font-medium">Collected</th>
                  <th className="py-1 pr-3 font-medium">Refunded</th>
                  <th className="py-1 font-medium">Net tax</th>
                </tr>
              </thead>
              <tbody>
                {report.locations.map((l) => (
                  <tr key={l.locationId} className="border-t border-border-default">
                    <td className="py-2 pr-3 text-text-primary">{l.locationName}</td>
                    <td className="py-2 pr-3">{money(l.taxableSalesMinorUnits)}</td>
                    <td className="py-2 pr-3">{money(l.taxCollectedMinorUnits)}</td>
                    <td className="py-2 pr-3">{money(l.taxRefundedMinorUnits)}</td>
                    <td className="py-2">{netTaxLabel(l.netTaxMinorUnits, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <Card className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-text-primary">Refunds and cancellations</h2>
        {report.refunds.length === 0 ? (
          <p className="text-sm text-text-secondary">None in this period.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-default">
            {report.refunds.map((r, i) => {
              const status = taxRefundStatusView(r.status);
              return (
                <li
                  key={`${r.orderId}-${i}`}
                  className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex flex-col">
                    <span className="text-sm text-text-primary">
                      Order {r.orderNumber} · {taxRefundKindLabel(r.kind)}
                    </span>
                    <span className="text-xs text-text-muted">
                      {r.locationName} ·{" "}
                      {new Date(r.date).toLocaleDateString("en-US", { dateStyle: "medium" })}{" "}
                      · {money(r.amountMinorUnits)}
                      {r.taxMinorUnits !== null
                        ? ` · ${money(r.taxMinorUnits)} tax`
                        : " · tax unknown"}
                    </span>
                  </div>
                  <StatusBadge label={status.label} tone={status.tone} />
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Figure({
  label,
  value,
  strong,
  warning,
}: {
  label: string;
  value: string;
  strong?: boolean;
  warning?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd
        className={`${strong ? "text-lg font-semibold" : "text-base"} ${
          warning ? "text-status-warning" : "text-text-primary"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function Components({
  title,
  components,
  money,
  currency,
}: {
  title: string;
  components: SalesTaxReportComponent[];
  money: (v: number) => string;
  currency: string;
}) {
  if (components.length === 0) return null;
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      <ul className="flex flex-col divide-y divide-border-default">
        {components.map((c) => (
          <li
            key={`${c.jurisdiction}-${c.ratePercent}-${c.name}`}
            className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="text-sm text-text-primary">
              {c.name} ({c.ratePercent}%)
              <span className="block text-xs text-text-muted">
                Taxable {money(c.taxableSalesMinorUnits)}
              </span>
            </span>
            <span className="text-sm text-text-secondary">
              Collected {money(c.taxCollectedMinorUnits)} · Refunded{" "}
              {money(c.taxRefundedMinorUnits)} · Net{" "}
              {netTaxLabel(c.netTaxMinorUnits, currency)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
