import Link from "next/link";
import type {
  AdminCustomerGrowthReport,
  AdminOrdersOverviewReport,
  OrderStatus,
} from "@mocha-house/contracts";
import {
  OVERVIEW_TIME_ZONE,
  type ChecklistState,
  type OverviewLocationRow,
  type OverviewRange,
} from "@/lib/admin/overview";
import { formatPrice } from "@/lib/money";
import {
  IconAlert,
  IconArrowRight,
  IconCheck,
  IconCheckCircle,
  IconChevronDown,
  IconCustomers,
  IconOrders,
} from "@/components/centerivo/Icons";
import { RangeTabs, type ContinueLink } from "./OverviewSections";
import { ORDER_STATUS_LABEL } from "./StatusBadge";

// Company-wide Overview presentation ("the brief"). Every figure is passed
// through from an API report; the only arithmetic here is display shares for
// bars, which are always accompanied by the underlying numbers.

const CURRENCY = "USD";

const NUMBER_WORDS = [
  "No",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
];

function countWord(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

// "today" / "in the last 7 days" — for sentences, not labels.
export function periodPhrase(range: OverviewRange): string {
  if (range === "today") return "today";
  return range === "7d" ? "in the last 7 days" : "in the last 30 days";
}

function rise(step: number): React.CSSProperties {
  return { animationDelay: `${step * 60}ms` };
}

// ---------------------------------------------------------------------------
// The brief: one sentence that says where to start, with the business, scope
// and the single period control for every period-based figure on the page.
// ---------------------------------------------------------------------------
export function OverviewHero({
  businessName,
  locationCount,
  attentionCount,
  warningCount,
  unavailable,
  range,
  periodLabel,
  hrefFor,
  showPeriod,
  links,
}: {
  businessName: string;
  locationCount: number;
  attentionCount: number;
  warningCount: number;
  unavailable: string[];
  range: OverviewRange;
  periodLabel: string;
  hrefFor: (range: OverviewRange) => string;
  showPeriod: boolean;
  links: ContinueLink[];
}) {
  const state =
    attentionCount > 0 ? "attention" : unavailable.length > 0 ? "partial" : "clear";

  const headline =
    state === "attention"
      ? `${countWord(attentionCount)} ${
          attentionCount === 1 ? "thing" : "things"
        } ${warningCount > 0 ? (attentionCount === 1 ? "needs" : "need") : "to"} ${
          warningCount > 0 ? "your attention" : "review"
        }`
      : state === "partial"
        ? "Some checks couldn\u2019t be completed"
        : locationCount === 1
          ? "All clear at your location"
          : `All clear across ${locationCount} locations`;

  const subline =
    state === "attention"
      ? "Most urgent first. Each item links straight to where it\u2019s handled."
      : state === "partial"
        ? `Couldn\u2019t load ${unavailable.join(", ")}. Refresh to try again.`
        : "Nothing is waiting on a decision. Here\u2019s how the business is doing.";

  const markTone =
    state === "clear"
      ? "bg-accent-soft text-accent"
      : "bg-status-warning/10 text-status-warning";
  const MarkIcon = state === "clear" ? IconCheckCircle : IconAlert;

  return (
    <header className="cx-rise flex flex-col gap-6" style={rise(0)}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
        <div className="flex min-w-0 flex-col gap-4">
          <dl className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
            <div className="flex">
              <dt className="sr-only">Business</dt>
              <dd className="font-medium text-text-primary">{businessName}</dd>
            </div>
            <span aria-hidden="true" className="text-text-muted">
              /
            </span>
            <div className="flex">
              <dt className="sr-only">Scope</dt>
              <dd className="flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-0.5 text-[0.8125rem] font-medium text-accent">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
                Company-wide
              </dd>
            </div>
            <div className="flex">
              <dt className="sr-only">Includes</dt>
              <dd className="text-text-secondary">
                {locationCount === 1 ? "1 location" : `${locationCount} locations`}
              </dd>
            </div>
          </dl>

          <div className="flex items-start gap-4">
            <span
              aria-hidden="true"
              className={`mt-1 hidden h-11 w-11 shrink-0 items-center justify-center rounded-2xl sm:flex ${markTone}`}
            >
              <MarkIcon className="h-5.5 w-5.5" />
            </span>
            <div className="flex min-w-0 flex-col gap-1.5">
              <p
                role="status"
                className="text-pretty text-[1.75rem] font-semibold leading-[1.15] tracking-tight text-text-primary md:text-[2.25rem]"
              >
                {headline}
                <span className="text-text-muted">.</span>
              </p>
              <p className="text-pretty text-[0.9375rem] leading-relaxed text-text-secondary">
                {subline}
              </p>
            </div>
          </div>
        </div>

        {showPeriod ? (
          <div className="flex flex-col gap-2 lg:items-end">
            <RangeTabs current={range} hrefFor={hrefFor} />
            <details className="group/period relative">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-[0.8125rem] text-text-secondary tabular-nums hover:text-text-primary lg:justify-end [&::-webkit-details-marker]:hidden">
                {periodLabel}
                <IconChevronDown className="h-3.5 w-3.5 text-text-muted transition-transform group-open/period:rotate-180" />
              </summary>
              <p className="mt-2 max-w-xs text-[0.8125rem] leading-relaxed text-text-muted lg:text-right">
                Business dates, inclusive, in {OVERVIEW_TIME_ZONE}. Applies to
                every figure below. Checklists always show today.
              </p>
            </details>
          </div>
        ) : null}
      </div>

      {links.length > 0 ? (
        <nav
          aria-label="Continue working"
          className="-mx-1 flex items-center gap-1 overflow-x-auto border-t border-border-default pt-3 [scrollbar-width:none]"
        >
          <span className="shrink-0 px-1 text-[0.8125rem] text-text-muted">Go to</span>
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              title={link.description}
              className="group/link flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-subtle hover:text-text-primary"
            >
              {link.label}
              <IconArrowRight className="h-3.5 w-3.5 text-text-muted transition-transform group-hover/link:translate-x-0.5 group-hover/link:text-accent" />
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}

// ---------------------------------------------------------------------------
// Shared panel scaffolding
// ---------------------------------------------------------------------------
export function PanelSection({
  id,
  title,
  aside,
  step = 1,
  className = "",
  children,
}: {
  id: string;
  title: string;
  aside?: React.ReactNode;
  step?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`cx-rise flex min-w-0 flex-col gap-3 ${className}`}
      style={rise(step)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2
          id={id}
          className="text-lg font-semibold tracking-tight text-text-primary"
        >
          {title}
        </h2>
        {aside ? <div className="text-sm text-text-muted">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

const card =
  "overflow-hidden rounded-2xl border border-border-default bg-surface-card";

function HowCounted({ children }: { children: React.ReactNode }) {
  return (
    <details className="group/how border-t border-border-default">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 text-[0.8125rem] font-medium text-text-secondary transition-colors hover:text-text-primary md:px-6 [&::-webkit-details-marker]:hidden">
        How these are counted
        <IconChevronDown className="h-4 w-4 text-text-muted transition-transform group-open/how:rotate-180" />
      </summary>
      <ul className="flex flex-col gap-1.5 px-5 pb-4 text-[0.8125rem] leading-relaxed text-text-secondary md:px-6">
        {children}
      </ul>
    </details>
  );
}

function EmptyPanel({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof IconOrders;
  title: string;
  description: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 px-5 py-6 md:px-6 md:py-8">
      <span
        aria-hidden="true"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-subtle text-text-muted"
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-[0.9375rem] font-semibold text-text-primary">{title}</p>
        <p className="text-pretty text-sm leading-relaxed text-text-secondary">
          {description}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Needs attention — the all-clear state. (Items render via AttentionList.)
// ---------------------------------------------------------------------------
export function AllClearPanel({ checked }: { checked: string[] }) {
  return (
    <div className={`${card} flex flex-col`}>
      <div className="flex flex-col gap-1 px-5 pb-4 pt-5 md:px-6">
        <p className="text-[0.9375rem] font-semibold text-text-primary">
          Nothing waiting on you
        </p>
        <p className="text-sm text-text-secondary">
          These were checked just now, across every location you can see.
        </p>
      </div>
      <ul className="grid gap-x-6 gap-y-2.5 border-t border-border-default px-5 py-4 text-sm sm:grid-cols-2 md:px-6">
        {checked.map((label) => (
          <li key={label} className="flex items-center gap-2.5 text-text-secondary">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
              <IconCheck className="h-3 w-3" />
            </span>
            <span className="first-letter:uppercase">{label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Digital performance — one business snapshot: sales leads, orders and the
// average support it, and the order journey shows where orders are now.
// ---------------------------------------------------------------------------
const PIPELINE: OrderStatus[] = [
  "RECEIVED",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "COMPLETED",
];

// One hue: neutrals for in-progress steps, the accent for completed.
const PIPELINE_TONE: Record<OrderStatus, string> = {
  RECEIVED: "rgb(23 32 29 / 0.14)",
  ACCEPTED: "rgb(23 32 29 / 0.26)",
  PREPARING: "rgb(23 32 29 / 0.4)",
  READY: "rgb(31 92 79 / 0.5)",
  COMPLETED: "var(--accent)",
};

export function DigitalPerformance({
  report,
  range,
}: {
  report: AdminOrdersOverviewReport;
  range: OverviewRange;
}) {
  const total = report.totalOrders;
  const included = report.availableLocations.length;

  if (total === 0) {
    return (
      <div className={card}>
        <EmptyPanel
          icon={IconOrders}
          title={`No digital orders ${periodPhrase(range)}`}
          description="Sales, order count and order progress will appear here as soon as customers order online."
        />
        <p className="border-t border-border-default px-5 py-3 text-[0.8125rem] text-text-muted md:px-6">
          {report.source.scopeLabel} · {included}{" "}
          {included === 1 ? "location" : "locations"} included
        </p>
      </div>
    );
  }

  const inProgress = total - report.completedOrders;

  return (
    <div className={card}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 px-5 pb-5 pt-5 md:px-6 md:pt-6">
        <div className="col-span-2 flex flex-col gap-1.5">
          <dt className="text-sm font-medium text-text-secondary">Digital sales</dt>
          <dd className="text-[2.5rem] font-semibold leading-none tracking-tight text-text-primary tabular-nums md:text-[3.25rem]">
            {formatPrice(report.digitalSalesMinorUnits, CURRENCY)}
          </dd>
          <dd className="text-[0.8125rem] text-text-muted">
            {report.source.scopeLabel}
          </dd>
        </div>
        <div className="flex flex-col gap-1 border-t border-border-default pt-4">
          <dt className="text-sm text-text-secondary">Orders</dt>
          <dd className="text-2xl font-semibold tracking-tight text-text-primary tabular-nums">
            {total}
          </dd>
        </div>
        <div className="flex flex-col gap-1 border-t border-border-default pt-4">
          <dt className="text-sm text-text-secondary">Average order</dt>
          <dd className="text-2xl font-semibold tracking-tight text-text-primary tabular-nums">
            {formatPrice(report.averageOrderValueMinorUnits, CURRENCY)}
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-3 border-t border-border-default bg-surface-subtle/40 px-5 py-4 md:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <p className="text-sm font-medium text-text-primary">Where these orders are now</p>
          <p className="text-[0.8125rem] text-text-secondary tabular-nums">
            {report.completedOrders} completed · {inProgress} in progress
          </p>
        </div>
        <div
          role="img"
          aria-label={PIPELINE.map(
            (s) => `${ORDER_STATUS_LABEL[s]} ${report.statusBreakdown[s]}`,
          ).join(", ")}
          className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-border-default/60"
        >
          {PIPELINE.filter((s) => report.statusBreakdown[s] > 0).map((s) => (
            <span
              key={s}
              style={{ flexGrow: report.statusBreakdown[s], background: PIPELINE_TONE[s] }}
            />
          ))}
        </div>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[0.8125rem] text-text-secondary sm:flex sm:flex-wrap sm:gap-x-5">
          {PIPELINE.map((s) => (
            <li key={s} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full"
                style={{ background: PIPELINE_TONE[s] }}
              />
              {ORDER_STATUS_LABEL[s]}
              <span className="font-medium text-text-primary tabular-nums">
                {report.statusBreakdown[s]}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <HowCounted>
        <li>
          <span className="font-medium text-text-primary">Digital sales</span> are
          after discounts and exclude tax, tips and refunds. Gift cards count as
          payment, not discount.
        </li>
        <li>
          <span className="font-medium text-text-primary">Average order</span> is
          digital sales divided by digital orders.
        </li>
        <li>
          Order progress is each order&rsquo;s current status, so recent orders
          may still be in progress.
        </li>
        <li>
          {report.source.scopeLabel} · {report.source.freshnessLabel} · {included}{" "}
          {included === 1 ? "location" : "locations"} included.
        </li>
      </HowCounted>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customer activity
// ---------------------------------------------------------------------------
function CustomerFigure({
  label,
  hint,
  value,
}: {
  label: string;
  hint: string;
  value: number;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-5 py-4 md:px-6 md:py-5">
      <dt className="text-sm text-text-secondary">
        {label}
        <span className="block text-xs text-text-muted">{hint}</span>
      </dt>
      <dd className="order-first text-[1.75rem] font-semibold leading-none tracking-tight text-text-primary tabular-nums">
        {value}
      </dd>
    </div>
  );
}

export function CustomerActivity({
  growth,
  range,
  loyaltyHref,
  customersHref,
}: {
  growth: AdminCustomerGrowthReport;
  range: OverviewRange;
  loyaltyHref: string | null;
  customersHref: string | null;
}) {
  const orderTotal = growth.registeredCustomerOrders + growth.guestOrders;
  const quiet =
    orderTotal === 0 &&
    growth.newRegisteredCustomers === 0 &&
    growth.registeredCustomersWithOrders === 0;
  const signedInShare =
    orderTotal > 0 ? Math.round((growth.registeredCustomerOrders / orderTotal) * 100) : 0;

  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border-default px-5 py-3 text-sm md:px-6">
      <p className="text-text-secondary">
        <span className="font-semibold text-text-primary tabular-nums">
          {growth.registeredCustomersAsOfEndDate}
        </span>{" "}
        registered accounts at period end
      </p>
      <div className="flex items-center gap-4">
        {loyaltyHref ? (
          <Link
            href={loyaltyHref}
            className="group/link flex items-center gap-1.5 font-medium text-text-secondary hover:text-text-primary"
          >
            Loyalty
            <IconArrowRight className="h-3.5 w-3.5 text-text-muted transition-transform group-hover/link:translate-x-0.5 group-hover/link:text-accent" />
          </Link>
        ) : null}
        {customersHref ? (
          <Link
            href={customersHref}
            className="group/link flex items-center gap-1.5 font-medium text-text-secondary hover:text-text-primary"
          >
            Customers
            <IconArrowRight className="h-3.5 w-3.5 text-text-muted transition-transform group-hover/link:translate-x-0.5 group-hover/link:text-accent" />
          </Link>
        ) : null}
      </div>
    </div>
  );

  const definitions = (
    <HowCounted>
      <li>
        <span className="font-medium text-text-primary">New accounts</span>{" "}
        registered during the period.{" "}
        <span className="font-medium text-text-primary">Ordered</span> counts
        registered customers with at least one digital order in the period.{" "}
        <span className="font-medium text-text-primary">Came back</span> counts
        those with two or more orders within the same period.
      </li>
      <li>
        Registered accounts is a running total at the end of the period, not a
        period figure.
      </li>
      <li>
        Loyalty balances and redemptions aren&rsquo;t summarized company-wide
        yet. {growth.source.scopeLabel}.
      </li>
    </HowCounted>
  );

  if (quiet) {
    return (
      <div className={card}>
        <EmptyPanel
          icon={IconCustomers}
          title={`No customer activity ${periodPhrase(range)}`}
          description="New sign-ups, ordering customers and repeat visits will show here once customers start ordering online."
        />
        {footer}
        {definitions}
      </div>
    );
  }

  return (
    <div className={card}>
      <div className="grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <dl className="grid grid-cols-3 divide-x divide-border-default">
          <CustomerFigure
            label="New accounts"
            hint="Signed up"
            value={growth.newRegisteredCustomers}
          />
          <CustomerFigure
            label="Ordered"
            hint="At least once"
            value={growth.registeredCustomersWithOrders}
          />
          <CustomerFigure
            label="Came back"
            hint="2+ orders"
            value={growth.repeatRegisteredCustomers}
          />
        </dl>
        <div className="flex flex-col justify-center gap-2.5 border-t border-border-default px-5 py-4 md:px-6 lg:border-l lg:border-t-0">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-sm font-medium text-text-primary">Who placed orders</p>
            {orderTotal > 0 ? (
              <p className="text-[0.8125rem] text-text-secondary tabular-nums">
                {signedInShare}% signed in
              </p>
            ) : null}
          </div>
          {orderTotal > 0 ? (
            <>
              <div
                role="img"
                aria-label={`${growth.registeredCustomerOrders} orders from registered customers, ${growth.guestOrders} guest orders`}
                className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
              >
                {growth.registeredCustomerOrders > 0 ? (
                  <span className="bg-accent" style={{ flexGrow: growth.registeredCustomerOrders }} />
                ) : null}
                {growth.guestOrders > 0 ? (
                  <span className="bg-text-muted/30" style={{ flexGrow: growth.guestOrders }} />
                ) : null}
              </div>
              <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[0.8125rem] text-text-secondary">
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
              No digital orders {periodPhrase(range)}.
            </p>
          )}
        </div>
      </div>
      {footer}
      {definitions}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------
const CHECKLIST_TEXT: Record<ChecklistState, string> = {
  completed: "Done",
  "in-progress": "In progress",
  "not-recorded": "Not recorded",
};

function ChecklistMark({ state }: { state: ChecklistState | null }) {
  if (state === null) return <span className="text-text-muted">—</span>;
  return (
    <span
      className={`flex items-center gap-1.5 whitespace-nowrap ${
        state === "not-recorded" ? "text-text-muted" : "text-text-primary"
      }`}
    >
      {state === "completed" ? (
        <IconCheck className="h-3.5 w-3.5 text-accent" />
      ) : state === "in-progress" ? (
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-text-secondary" />
      ) : (
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full border border-text-muted" />
      )}
      {CHECKLIST_TEXT[state]}
    </span>
  );
}

function OrderingState({ row }: { row: OverviewLocationRow }) {
  if (!row.isActive) {
    return <span className="whitespace-nowrap text-text-muted">Inactive</span>;
  }
  return row.isDigitalOrderingEnabled ? (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-text-primary">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
      On
    </span>
  ) : (
    <span className="flex items-center gap-1.5 whitespace-nowrap font-medium text-status-warning">
      <IconAlert className="h-3.5 w-3.5" />
      Off
    </span>
  );
}

function Flags({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null;
  return (
    <span className="flex items-start gap-1.5 text-[0.8125rem] leading-snug text-status-warning">
      <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{flags.join(" · ")}</span>
    </span>
  );
}

export function LocationsSummary({
  total,
  needingLook,
}: {
  total: number;
  needingLook: number;
}) {
  return (
    <span>
      <span className="tabular-nums">{total}</span>{" "}
      {total === 1 ? "location" : "locations"}
      {needingLook > 0 ? (
        <span className="font-medium text-status-warning tabular-nums">
          {" "}
          · {needingLook} {needingLook === 1 ? "needs" : "need"} a look
        </span>
      ) : null}
    </span>
  );
}

export function LocationBoard({
  rows,
  hrefFor,
  periodName,
  showChecklists,
  checklistsUnavailable,
}: {
  rows: OverviewLocationRow[];
  hrefFor: (locationId: string) => string;
  periodName: string;
  showChecklists: boolean;
  checklistsUnavailable: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className={card}>
        <EmptyPanel
          icon={IconOrders}
          title="No locations to compare yet"
          description="Locations appear here once they're set up and assigned to you."
        />
      </div>
    );
  }

  const maxSales = Math.max(...rows.map((r) => r.salesMinorUnits));
  const share = (row: OverviewLocationRow) =>
    maxSales > 0 ? (row.salesMinorUnits / maxSales) * 100 : 0;
  const avg = (row: OverviewLocationRow) =>
    row.orders > 0 ? formatPrice(row.averageOrderMinorUnits, CURRENCY) : "—";
  const flaggedRule = (row: OverviewLocationRow) =>
    row.flags.length > 0
      ? { boxShadow: "inset 3px 0 0 var(--status-warning)" }
      : undefined;
  const th = "py-3 text-xs font-medium text-text-muted";

  return (
    <div className={card}>
      <table className="hidden w-full text-left text-sm md:table">
        <caption className="sr-only">
          Online ordering, digital orders and sales ({periodName}) and
          today&rsquo;s checklists by location
        </caption>
        <thead>
          <tr className="border-b border-border-default">
            <th scope="col" className={`${th} pl-6 pr-4`}>Location</th>
            <th scope="col" className={`${th} px-4`}>Online ordering</th>
            <th scope="col" className={`${th} px-4 text-right`}>Orders</th>
            <th scope="col" className={`${th} w-[22%] px-4 text-right`}>Digital sales</th>
            <th scope="col" className={`${th} px-4 text-right`}>Avg order</th>
            {showChecklists ? (
              <>
                <th scope="col" className={`${th} pl-8 pr-4`}>Opening today</th>
                <th scope="col" className={`${th} px-4`}>Closing today</th>
              </>
            ) : null}
            <th scope="col" className="w-12 pr-4">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-default">
          {rows.map((row) => (
            <tr
              key={row.locationId}
              className="group/row align-middle transition-colors hover:bg-surface-subtle/50"
            >
              <th
                scope="row"
                className="py-4 pl-6 pr-4 font-normal"
                style={flaggedRule(row)}
              >
                <span className="flex flex-col gap-1">
                  <Link
                    href={hrefFor(row.locationId)}
                    className="w-fit text-[0.9375rem] font-semibold text-text-primary underline-offset-4 hover:underline"
                  >
                    {row.name}
                  </Link>
                  <Flags flags={row.flags} />
                </span>
              </th>
              <td className="px-4 py-4">
                <OrderingState row={row} />
              </td>
              <td className="px-4 py-4 text-right font-medium text-text-primary tabular-nums">
                {row.orders}
              </td>
              <td className="px-4 py-4 text-right">
                <span className="flex flex-col items-end gap-1.5">
                  <span className="text-text-primary tabular-nums">
                    {formatPrice(row.salesMinorUnits, CURRENCY)}
                  </span>
                  {maxSales > 0 ? (
                    <span
                      aria-hidden="true"
                      className="block h-1 w-full max-w-28 overflow-hidden rounded-full bg-surface-subtle"
                    >
                      <span
                        className="ml-auto block h-full rounded-full bg-accent/70"
                        style={{ width: `${share(row)}%` }}
                      />
                    </span>
                  ) : null}
                </span>
              </td>
              <td className="px-4 py-4 text-right text-text-secondary tabular-nums">
                {avg(row)}
              </td>
              {showChecklists ? (
                <>
                  <td className="py-4 pl-8 pr-4">
                    <ChecklistMark state={row.checklist?.opening ?? null} />
                  </td>
                  <td className="px-4 py-4">
                    <ChecklistMark state={row.checklist?.closing ?? null} />
                  </td>
                </>
              ) : null}
              <td className="py-4 pr-4 text-right">
                <Link
                  href={hrefFor(row.locationId)}
                  aria-hidden="true"
                  tabIndex={-1}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-all group-hover/row:translate-x-0.5 group-hover/row:text-accent"
                >
                  <IconArrowRight className="h-4 w-4" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="divide-y divide-border-default md:hidden">
        {rows.map((row) => (
          <li key={row.locationId} style={flaggedRule(row)}>
            <Link
              href={hrefFor(row.locationId)}
              aria-label={row.flags.length > 0 ? `${row.name}, needs a look` : row.name}
              aria-describedby={`loc-${row.locationId}-details`}
              className="flex flex-col gap-3 px-4 py-4 transition-colors active:bg-surface-subtle/60"
            >
              <span className="flex items-start justify-between gap-3">
                <span className="min-w-0 break-words text-[0.9375rem] font-semibold leading-snug text-text-primary">
                  {row.name}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-sm">
                  <span className="sr-only">Online ordering:</span>
                  <OrderingState row={row} />
                  <IconArrowRight className="h-4 w-4 text-text-muted" />
                </span>
              </span>
              <span id={`loc-${row.locationId}-details`} className="flex flex-col gap-3">
                <Flags flags={row.flags} />
                <span className="grid grid-cols-3 gap-3 rounded-xl bg-surface-subtle/60 px-3 py-2.5">
                  {[
                    ["Orders", String(row.orders)],
                    ["Sales", formatPrice(row.salesMinorUnits, CURRENCY)],
                    ["Avg order", avg(row)],
                  ].map(([label, value]) => (
                    <span key={label} className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-xs text-text-muted">{label}</span>
                      <span className="truncate text-sm font-semibold text-text-primary tabular-nums">
                        {value}
                      </span>
                    </span>
                  ))}
                </span>
                {showChecklists ? (
                  <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem]">
                    <span className="flex items-center gap-1.5">
                      <span className="text-text-muted">Opening</span>
                      <ChecklistMark state={row.checklist?.opening ?? null} />
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="text-text-muted">Closing</span>
                      <ChecklistMark state={row.checklist?.closing ?? null} />
                    </span>
                  </span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <p className="border-t border-border-default px-5 py-3 text-xs leading-relaxed text-text-muted md:px-6">
        Digital platform orders only, {periodName.toLowerCase()}.{" "}
        {showChecklists
          ? "Checklists show today\u2019s recorded activity — \u201cNot recorded\u201d means not opened yet, not missed."
          : checklistsUnavailable
            ? "Checklist status couldn\u2019t be loaded."
            : ""}
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
      className="flex items-start gap-3 rounded-2xl border border-dashed border-border-default bg-surface-card px-5 py-5 md:px-6"
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
