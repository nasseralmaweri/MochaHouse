import Link from "next/link";
import type {
  AdminCustomerGrowthReport,
  AdminOrdersOverviewReport,
  OrderStatus,
} from "@mocha-house/contracts";
import { OVERVIEW_TIME_ZONE, type OverviewRange } from "@/lib/admin/overview";
import { formatPrice } from "@/lib/money";
import { DataCoverage } from "@/components/centerivo/DataCoverage";
import {
  IconAlert,
  IconArrowRight,
  IconInfo,
} from "@/components/centerivo/Icons";
import { RangeTabs } from "./OverviewSections";
import { ORDER_STATUS_LABEL } from "./StatusBadge";

// Company-wide Overview presentation. Every figure is passed through from an
// API report; the only arithmetic here is a display share for a bar.

const CURRENCY = "USD";

// Business -> Scope in one quiet line, so the active business and the
// company-wide scope are stated once and never implied.
export function ScopeContext({
  businessName,
  locationCount,
}: {
  businessName: string;
  locationCount: number;
}) {
  return (
    <dl className="-mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <div className="flex items-center">
        <dt className="sr-only">Business</dt>
        <dd className="font-medium text-text-primary">{businessName}</dd>
      </div>
      <span aria-hidden="true" className="text-border-default">
        /
      </span>
      <div className="flex items-center">
        <dt className="sr-only">Scope</dt>
        <dd className="flex items-center gap-1.5 font-medium text-accent">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
          Company-wide
        </dd>
      </div>
      <span aria-hidden="true" className="text-border-default">
        /
      </span>
      <div className="flex items-center">
        <dt className="sr-only">Includes</dt>
        <dd className="text-text-secondary">
          {locationCount === 1
            ? "1 location you can see"
            : `All ${locationCount} locations you can see`}
        </dd>
      </div>
    </dl>
  );
}

// One period control for every period-based figure below it, with the
// exact business dates spelled out beside it.
export function ReportingPeriodBar({
  range,
  periodLabel,
  hrefFor,
}: {
  range: OverviewRange;
  periodLabel: string;
  hrefFor: (range: OverviewRange) => string;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border-default pb-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
          Reporting period
        </p>
        <p className="text-[0.9375rem] font-semibold text-text-primary tabular-nums">
          {periodLabel}
        </p>
        <p className="text-xs text-text-muted">
          Business dates, inclusive · {OVERVIEW_TIME_ZONE}
        </p>
        <p className="text-xs leading-snug text-text-muted">
          Used for digital performance, customer activity and location
          orders and sales. Opening and closing checklists always show today.
        </p>
      </div>
      <div className="shrink-0">
        <RangeTabs current={range} hrefFor={hrefFor} />
      </div>
    </div>
  );
}

// A figure that reads as a compact row on phones (label + definition left,
// value right) and as a stacked tile from md up.
function Metric({
  label,
  value,
  definition,
  size = "lg",
}: {
  label: string;
  value: string;
  definition: string;
  size?: "lg" | "md";
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 px-4 py-3.5 sm:px-5 md:grid-cols-1 md:items-start md:gap-y-2 md:px-6 md:py-5">
      <dt className="col-start-1 row-start-1 text-sm font-medium text-text-secondary">
        {label}
      </dt>
      <dd
        className={`col-start-2 row-span-2 row-start-1 font-semibold leading-none tracking-tight text-text-primary tabular-nums md:col-start-1 md:row-span-1 md:row-start-2 ${
          size === "lg" ? "text-xl md:text-[2rem]" : "text-xl md:text-[1.625rem]"
        }`}
      >
        {value}
      </dd>
      <dd className="col-start-1 row-start-2 text-xs leading-snug text-text-muted md:row-start-3 md:text-[0.8125rem]">
        {definition}
      </dd>
    </div>
  );
}

const PIPELINE: OrderStatus[] = [
  "RECEIVED",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "COMPLETED",
];

const cardClass =
  "overflow-hidden rounded-2xl border border-border-default bg-surface-card";
const metricGridClass =
  "grid divide-y divide-border-default md:grid-cols-3 md:divide-x md:divide-y-0";

export function DigitalPerformance({
  report,
  periodLabel,
}: {
  report: AdminOrdersOverviewReport;
  periodLabel: string;
}) {
  const total = report.totalOrders;
  const inProgress = total - report.completedOrders;
  const completedShare = total > 0 ? (report.completedOrders / total) * 100 : 0;

  return (
    <div className="flex flex-col gap-2.5">
      <div className={cardClass}>
        <dl className={metricGridClass}>
          <Metric
            label="Digital orders"
            value={String(total)}
            definition="All digital orders, any status"
          />
          <Metric
            label="Digital sales"
            value={formatPrice(report.digitalSalesMinorUnits, CURRENCY)}
            definition="After discounts · excludes tax, tips, refunds"
          />
          <Metric
            label="Average order"
            value={
              total > 0
                ? formatPrice(report.averageOrderValueMinorUnits, CURRENCY)
                : "—"
            }
            definition={total > 0 ? "Digital sales ÷ digital orders" : "Needs at least one order"}
          />
        </dl>

        <div className="flex flex-col gap-2.5 border-t border-border-default bg-surface-subtle/30 px-4 py-3.5 sm:px-5 md:px-6">
          {total > 0 ? (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5 text-sm">
                <p className="text-text-primary">
                  <span className="font-semibold tabular-nums">
                    {report.completedOrders}
                  </span>{" "}
                  completed
                  <span className="px-1.5 text-text-muted">·</span>
                  <span className="font-semibold tabular-nums">{inProgress}</span>{" "}
                  in progress
                </p>
                <p className="text-xs text-text-muted">
                  Current status of orders placed in this period
                </p>
              </div>
              <div
                role="img"
                aria-label={`${report.completedOrders} of ${total} orders completed`}
                className="h-1 w-full overflow-hidden rounded-full bg-border-default/70"
              >
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${completedShare}%` }}
                />
              </div>
              <ul className="grid grid-cols-3 gap-x-4 gap-y-1 text-xs text-text-secondary sm:flex sm:flex-wrap sm:gap-x-5 sm:text-[0.8125rem]">
                {PIPELINE.map((status) => (
                  <li key={status} className="flex items-baseline gap-1.5">
                    {ORDER_STATUS_LABEL[status]}
                    <span className="font-medium text-text-primary tabular-nums">
                      {report.statusBreakdown[status]}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-text-secondary">
              No digital orders were placed in {periodLabel}.
            </p>
          )}
        </div>
      </div>
      <DataCoverage
        items={[
          report.source.scopeLabel,
          report.source.freshnessLabel,
          `${report.availableLocations.length} ${
            report.availableLocations.length === 1 ? "location" : "locations"
          } included`,
        ]}
      />
    </div>
  );
}

export function CustomerActivity({
  growth,
  loyaltyHref,
  customersHref,
}: {
  growth: AdminCustomerGrowthReport;
  loyaltyHref: string | null;
  customersHref: string | null;
}) {
  const orderTotal = growth.registeredCustomerOrders + growth.guestOrders;
  const registeredShare =
    orderTotal > 0 ? (growth.registeredCustomerOrders / orderTotal) * 100 : 0;

  return (
    <div className="flex flex-col gap-2.5">
      <div className={cardClass}>
        <dl className={metricGridClass}>
          <Metric
            size="md"
            label="New accounts"
            value={String(growth.newRegisteredCustomers)}
            definition="Registered in this period"
          />
          <Metric
            size="md"
            label="Ordering accounts"
            value={String(growth.registeredCustomersWithOrders)}
            definition="Registered customers with at least one order in this period"
          />
          <Metric
            size="md"
            label="Repeat customers"
            value={String(growth.repeatRegisteredCustomers)}
            definition="Two or more orders in this period"
          />
        </dl>

        <div className="flex flex-col gap-2.5 border-t border-border-default bg-surface-subtle/30 px-4 py-3.5 sm:px-5 md:px-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5 text-sm">
            <p className="font-medium text-text-primary">Who placed orders</p>
            {orderTotal > 0 ? (
              <p className="text-xs text-text-muted tabular-nums">
                {Math.round(registeredShare)}% signed in
              </p>
            ) : null}
          </div>
          {orderTotal > 0 ? (
            <>
              <div
                role="img"
                aria-label={`${growth.registeredCustomerOrders} orders from registered customers, ${growth.guestOrders} guest orders`}
                className="flex h-1 w-full gap-0.5 overflow-hidden rounded-full"
              >
                {growth.registeredCustomerOrders > 0 ? (
                  <span
                    className="bg-accent"
                    style={{ flexGrow: growth.registeredCustomerOrders }}
                  />
                ) : null}
                {growth.guestOrders > 0 ? (
                  <span
                    className="bg-text-muted/30"
                    style={{ flexGrow: growth.guestOrders }}
                  />
                ) : null}
              </div>
              <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-secondary sm:text-[0.8125rem]">
                <li className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="h-2 w-2 rounded-full bg-accent" />
                  Registered
                  <span className="font-medium text-text-primary tabular-nums">
                    {growth.registeredCustomerOrders}
                  </span>
                </li>
                <li className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="h-2 w-2 rounded-full bg-text-muted/30" />
                  Guests
                  <span className="font-medium text-text-primary tabular-nums">
                    {growth.guestOrders}
                  </span>
                </li>
              </ul>
            </>
          ) : (
            <p className="text-sm text-text-secondary">
              No digital orders in this period yet.
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-border-default px-4 py-3 text-sm sm:px-5 md:px-6">
          <p className="text-text-secondary">
            <span className="font-semibold text-text-primary tabular-nums">
              {growth.registeredCustomersAsOfEndDate}
            </span>{" "}
            registered accounts as of period end
          </p>
          {customersHref ? (
            <Link
              href={customersHref}
              className="group flex shrink-0 items-center gap-1.5 rounded-md font-medium text-text-secondary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Customers
              <IconArrowRight className="h-4 w-4 text-text-muted group-hover:text-accent" />
            </Link>
          ) : null}
        </div>
      </div>

      <p className="flex flex-wrap items-start gap-x-2 gap-y-1 text-[0.8125rem] leading-snug text-text-secondary">
        <IconInfo className="mt-px h-3.5 w-3.5 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1">
          {growth.source.scopeLabel} · Loyalty balances and redemptions
          aren&rsquo;t summarized company-wide yet
          {loyaltyHref ? (
            <>
              {" · "}
              <Link
                href={loyaltyHref}
                className="font-medium text-text-primary underline decoration-border-default underline-offset-4 hover:decoration-accent"
              >
                Look up a customer in Loyalty
              </Link>
            </>
          ) : null}
        </span>
      </p>
    </div>
  );
}

// A section whose data couldn't be loaded. Never presented as zero.
export function SectionUnavailable({
  title,
  description = "The report didn't respond. Refresh to try again — nothing here is shown as zero.",
}: {
  title: string;
  description?: string;
}) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-2xl border border-dashed border-border-default bg-surface-card px-4 py-4 sm:px-5 md:px-6"
    >
      <span className="mt-0.5 text-status-warning">
        <IconAlert className="h-4.5 w-4.5" />
      </span>
      <div className="flex flex-col gap-0.5">
        <p className="text-[0.9375rem] font-medium text-text-primary">{title}</p>
        <p className="text-sm text-text-secondary">{description}</p>
      </div>
    </div>
  );
}

export function LocationsSummaryLine({
  total,
  needingLook,
}: {
  total: number;
  needingLook: number;
}) {
  return (
    <p className="text-sm text-text-secondary">
      <span className="tabular-nums">{total}</span>{" "}
      {total === 1 ? "location" : "locations"}
      {needingLook > 0 ? (
        <>
          <span className="px-1.5 text-text-muted">·</span>
          <span className="font-medium text-status-warning tabular-nums">
            {needingLook} {needingLook === 1 ? "needs" : "need"} a look
          </span>
        </>
      ) : null}
    </p>
  );
}
