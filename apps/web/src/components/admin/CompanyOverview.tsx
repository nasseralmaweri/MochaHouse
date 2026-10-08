import Link from "next/link";
import type {
  AdminCustomerGrowthReport,
  AdminOrdersOverviewReport,
  OrderStatus,
} from "@mocha-house/contracts";
import { OVERVIEW_TIME_ZONE, type OverviewRange } from "@/lib/admin/overview";
import { formatPrice } from "@/lib/money";
import { DataCoverage } from "@/components/centerivo/DataCoverage";
import { IconAlert, IconArrowRight } from "@/components/centerivo/Icons";
import { RangeTabs } from "./OverviewSections";
import { ORDER_STATUS_LABEL } from "./StatusBadge";

// Company-wide Overview presentation. Every figure is passed through from an
// API report; the only arithmetic here is a display share for a bar.

const CURRENCY = "USD";

// Business -> Scope, stated in words at the top of the page so the active
// business and the company-wide scope are never implied.
export function ScopeContext({
  businessName,
  locationCount,
}: {
  businessName: string;
  locationCount: number;
}) {
  return (
    <dl className="-mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 border-y border-border-default py-3 text-sm">
      <div className="flex items-center gap-2">
        <dt className="text-text-muted">Business</dt>
        <dd className="font-medium text-text-primary">{businessName}</dd>
      </div>
      <div className="flex items-center gap-2">
        <dt className="text-text-muted">Scope</dt>
        <dd className="flex items-center gap-2 font-medium text-text-primary">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-accent"
          />
          Company-wide
        </dd>
      </div>
      <div className="flex items-center gap-2">
        <dt className="text-text-muted">Includes</dt>
        <dd className="text-text-secondary">
          {locationCount === 1
            ? "The 1 location you can see"
            : `All ${locationCount} locations you can see`}
        </dd>
      </div>
    </dl>
  );
}

// One period control for every period-based figure on the page, with the
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
    <div className="flex flex-col gap-3 rounded-xl bg-surface-subtle/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium text-text-primary">
          <span className="text-text-muted">Reporting period: </span>
          {periodLabel}
        </p>
        <p className="text-[0.8125rem] text-text-secondary">
          Business dates, both ends inclusive ({OVERVIEW_TIME_ZONE}). Applies
          to digital performance, customer activity and location figures.
        </p>
      </div>
      <RangeTabs current={range} hrefFor={hrefFor} />
    </div>
  );
}

function Metric({
  label,
  value,
  definition,
}: {
  label: string;
  value: string;
  definition: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 px-5 py-5 sm:px-6">
      <dt className="text-sm font-medium text-text-secondary">{label}</dt>
      <dd className="flex flex-col gap-1.5">
        <span className="text-[2rem] font-semibold leading-none tracking-tight text-text-primary tabular-nums">
          {value}
        </span>
        <span className="text-[0.8125rem] leading-snug text-text-muted">
          {definition}
        </span>
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
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-2xl border border-border-default bg-surface-card">
        <dl className="grid divide-y divide-border-default md:grid-cols-3 md:divide-x md:divide-y-0">
          <Metric
            label="Online orders"
            value={String(total)}
            definition="Every digital order placed, any status"
          />
          <Metric
            label="Digital revenue"
            value={formatPrice(report.digitalSalesMinorUnits, CURRENCY)}
            definition="Subtotal after discounts. Excludes tax, tips and refunds"
          />
          <Metric
            label="Average order value"
            value={
              total > 0
                ? formatPrice(report.averageOrderValueMinorUnits, CURRENCY)
                : "—"
            }
            definition={
              total > 0
                ? "Digital revenue ÷ online orders"
                : "Shown once there are orders in this period"
            }
          />
        </dl>

        <div className="flex flex-col gap-3 border-t border-border-default px-5 py-4 sm:px-6">
          {total > 0 ? (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-sm">
                <p className="text-text-primary">
                  <span className="font-medium tabular-nums">
                    {report.completedOrders}
                  </span>{" "}
                  completed
                  <span className="text-text-muted"> · </span>
                  <span className="font-medium tabular-nums">{inProgress}</span>{" "}
                  still in progress
                </p>
                <p className="text-[0.8125rem] text-text-muted">
                  Current status of orders placed in this period
                </p>
              </div>
              <div
                role="img"
                aria-label={`${report.completedOrders} of ${total} orders completed`}
                className="h-1.5 w-full overflow-hidden rounded-full bg-surface-subtle"
              >
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${completedShare}%` }}
                />
              </div>
              <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[0.8125rem] text-text-secondary">
                {PIPELINE.map((status) => (
                  <li key={status}>
                    {ORDER_STATUS_LABEL[status]}{" "}
                    <span className="font-medium text-text-primary tabular-nums">
                      {report.statusBreakdown[status]}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-text-secondary">
              No digital orders were placed in this period ({periodLabel}).
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

function ActivityFigure({
  label,
  value,
  note,
}: {
  label: string;
  value: number;
  note: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <dt className="text-sm font-medium text-text-secondary">{label}</dt>
      <dd className="flex flex-col gap-1">
        <span className="text-2xl font-semibold leading-none tracking-tight text-text-primary tabular-nums">
          {value}
        </span>
        <span className="text-[0.8125rem] leading-snug text-text-muted">
          {note}
        </span>
      </dd>
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
    <div className="flex flex-col gap-3">
      <div className="flex flex-col overflow-hidden rounded-2xl border border-border-default bg-surface-card">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-6 px-5 py-5 sm:grid-cols-3 sm:px-6">
          <ActivityFigure
            label="New accounts"
            value={growth.newRegisteredCustomers}
            note="Customers who registered in this period"
          />
          <ActivityFigure
            label="Ordering accounts"
            value={growth.registeredCustomersWithOrders}
            note="Registered customers with at least one order"
          />
          <ActivityFigure
            label="Repeat customers"
            value={growth.repeatRegisteredCustomers}
            note="Two or more orders within this period"
          />
        </dl>

        <div className="flex flex-col gap-3 border-t border-border-default px-5 py-4 sm:px-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-sm">
            <p className="font-medium text-text-primary">Who placed orders</p>
            {orderTotal > 0 ? (
              <p className="text-[0.8125rem] text-text-muted">
                {Math.round(registeredShare)}% from signed-in customers
              </p>
            ) : null}
          </div>
          {orderTotal > 0 ? (
            <>
              <div
                role="img"
                aria-label={`${growth.registeredCustomerOrders} orders from registered customers, ${growth.guestOrders} guest orders`}
                className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full"
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
              <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[0.8125rem] text-text-secondary">
                <li className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 rounded-full bg-accent"
                  />
                  Registered customers{" "}
                  <span className="font-medium text-text-primary tabular-nums">
                    {growth.registeredCustomerOrders}
                  </span>
                </li>
                <li className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 rounded-full bg-text-muted/30"
                  />
                  Guests{" "}
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

        <div className="flex flex-col gap-2 border-t border-border-default bg-surface-subtle/40 px-5 py-3.5 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="text-text-secondary">
            <span className="font-medium text-text-primary tabular-nums">
              {growth.registeredCustomersAsOfEndDate}
            </span>{" "}
            registered accounts in total, as of the end of this period
          </p>
          {customersHref ? (
            <Link
              href={customersHref}
              className="group flex shrink-0 items-center gap-1.5 font-medium text-text-secondary hover:text-text-primary"
            >
              View customers
              <IconArrowRight className="h-4 w-4 text-text-muted group-hover:text-accent" />
            </Link>
          ) : null}
        </div>
      </div>

      <DataCoverage
        items={[
          growth.source.scopeLabel,
          "Loyalty balances and redemptions aren't summarized company-wide yet",
        ]}
      />
      {loyaltyHref ? (
        <Link
          href={loyaltyHref}
          className="group -mt-1 flex w-fit items-center gap-1.5 pl-5.5 text-[0.8125rem] font-medium text-text-secondary hover:text-text-primary"
        >
          Look up a customer&rsquo;s loyalty in Loyalty
          <IconArrowRight className="h-3.5 w-3.5 text-text-muted group-hover:text-accent" />
        </Link>
      ) : null}
    </div>
  );
}

// A section whose data couldn't be loaded. Never presented as zero.
export function SectionUnavailable({
  title,
  description = "The report didn't respond. Refresh the page to try again — nothing here is shown as zero.",
}: {
  title: string;
  description?: string;
}) {
  return (
    <div
      role="status"
      className="flex items-start gap-3.5 rounded-2xl border border-dashed border-border-default bg-surface-card px-5 py-5 sm:px-6"
    >
      <span className="mt-0.5 text-status-warning">
        <IconAlert className="h-5 w-5" />
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
          <span className="text-text-muted"> · </span>
          <span className="font-medium text-status-warning tabular-nums">
            {needingLook} {needingLook === 1 ? "needs" : "need"} a look
          </span>
        </>
      ) : null}
    </p>
  );
}
