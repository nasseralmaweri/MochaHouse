import Link from "next/link";
import type {
  AdminCustomerGrowthReport,
  AdminOrdersOverviewReport,
  OrderStatus,
  StoreOrderSummary,
} from "@mocha-house/contracts";
import {
  OVERVIEW_RANGES,
  type ChecklistState,
  type OverviewLocationRow,
  type OverviewRange,
} from "@/lib/admin/overview";
import { formatPrice } from "@/lib/money";
import { DataCoverage } from "@/components/centerivo/DataCoverage";
import {
  IconAlert,
  IconArrowRight,
  IconCheck,
} from "@/components/centerivo/Icons";
import { ORDER_STATUS_LABEL } from "./StatusBadge";

// Server-rendered Overview sections. They display figures the API returned —
// nothing here computes a metric beyond a display percentage for a bar.

const CURRENCY = "USD";

export function SectionHeading({
  id,
  title,
  description,
  aside,
  primary = false,
}: {
  id: string;
  title: string;
  description?: string;
  aside?: React.ReactNode;
  // The page's first operational priority gets a larger heading.
  primary?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="flex flex-col gap-0.5">
        <h2
          id={id}
          className={`font-semibold tracking-tight text-text-primary ${
            primary ? "text-xl" : "text-lg"
          }`}
        >
          {title}
        </h2>
        {description ? (
          <p className="text-sm text-text-secondary">{description}</p>
        ) : null}
      </div>
      {aside}
    </div>
  );
}

// Today / 7 days / 30 days as plain links (server-rendered, shareable URL).
export function RangeTabs({
  current,
  hrefFor,
}: {
  current: OverviewRange;
  hrefFor: (range: OverviewRange) => string;
}) {
  return (
    <nav aria-label="Reporting period">
      <ul className="flex rounded-lg bg-surface-subtle p-0.5 text-sm">
        {OVERVIEW_RANGES.map((range) => {
          const active = range.value === current;
          return (
            <li key={range.value}>
              <Link
                href={hrefFor(range.value)}
                aria-current={active ? "true" : undefined}
                scroll={false}
                className={`block rounded-md px-3 py-1.5 transition-colors ${
                  active
                    ? "bg-surface-card font-medium text-text-primary shadow-[var(--cx-shadow-raised)]"
                    : "text-text-secondary hover:text-text-primary"
                }`}
              >
                {range.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const STATUS_ORDER: OrderStatus[] = [
  "RECEIVED",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "COMPLETED",
];

// A ramp of the accent for in-progress statuses, the full accent for
// completed — one hue, so the bar informs without becoming a rainbow.
const STATUS_BAR_STYLE: Record<OrderStatus, React.CSSProperties> = {
  RECEIVED: {
    background: "color-mix(in srgb, var(--accent) 16%, transparent)",
  },
  ACCEPTED: {
    background: "color-mix(in srgb, var(--accent) 28%, transparent)",
  },
  PREPARING: {
    background: "color-mix(in srgb, var(--accent) 42%, transparent)",
  },
  READY: { background: "color-mix(in srgb, var(--accent) 62%, transparent)" },
  COMPLETED: { background: "var(--accent)" },
};

function Figure({
  label,
  value,
  note,
  small = false,
}: {
  label: string;
  value: string;
  note?: string;
  small?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-sm text-text-secondary">{label}</dt>
      <dd className="flex flex-col">
        <span
          className={`font-semibold leading-none tracking-tight text-text-primary tabular-nums ${
            small ? "text-xl" : "text-[1.75rem]"
          }`}
        >
          {value}
        </span>
        {note ? (
          <span className="mt-1.5 text-xs text-text-muted">{note}</span>
        ) : null}
      </dd>
    </div>
  );
}

export function PerformanceSummary({
  report,
  growth,
  headingId,
  coverageExtra,
}: {
  report: AdminOrdersOverviewReport;
  growth: AdminCustomerGrowthReport | null;
  headingId: string;
  coverageExtra: string[];
}) {
  const total = report.totalOrders;
  const inProgress = total - report.completedOrders;
  const segments = STATUS_ORDER.filter((s) => report.statusBreakdown[s] > 0);

  return (
    <div
      aria-labelledby={headingId}
      className="flex flex-col gap-6 rounded-2xl border border-border-default bg-surface-card p-5 sm:p-6"
    >
      <DataCoverage
        items={[
          report.source.scopeLabel,
          report.source.freshnessLabel,
          ...coverageExtra,
        ]}
      />

      <dl className="grid grid-cols-2 gap-x-8 gap-y-6 lg:grid-cols-4">
        <Figure
          label="Digital orders"
          value={String(total)}
          note={total > 0 ? `${inProgress} in progress` : undefined}
        />
        <Figure label="Completed" value={String(report.completedOrders)} />
        <Figure
          label="Digital sales"
          value={formatPrice(report.digitalSalesMinorUnits, CURRENCY)}
        />
        <Figure
          label="Average order"
          value={
            total > 0
              ? formatPrice(report.averageOrderValueMinorUnits, CURRENCY)
              : "—"
          }
        />
      </dl>

      {total > 0 ? (
        <div className="flex flex-col gap-2.5">
          <div
            role="img"
            aria-label={`Orders by status: ${segments
              .map((s) => `${ORDER_STATUS_LABEL[s]} ${report.statusBreakdown[s]}`)
              .join(", ")}`}
            className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
          >
            {segments.map((s) => (
              <span
                key={s}
                style={{
                  ...STATUS_BAR_STYLE[s],
                  flexGrow: report.statusBreakdown[s],
                }}
              />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-text-secondary">
            {segments.map((s) => (
              <li key={s} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 rounded-full"
                  style={STATUS_BAR_STYLE[s]}
                />
                {ORDER_STATUS_LABEL[s]}{" "}
                <span className="tabular-nums text-text-primary">
                  {report.statusBreakdown[s]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-text-secondary">
          No digital orders in this period yet.
        </p>
      )}

      {growth ? (
        <section
          aria-labelledby={`${headingId}-customers`}
          className="flex flex-col gap-4 border-t border-border-default pt-5"
        >
          <h3
            id={`${headingId}-customers`}
            className="text-sm font-medium text-text-primary"
          >
            Customer activity
          </h3>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-4 lg:grid-cols-4">
            <Figure
              small
              label="New customer accounts"
              value={String(growth.newRegisteredCustomers)}
            />
            <Figure
              small
              label="Accounts that ordered"
              value={String(growth.registeredCustomersWithOrders)}
              note={`${growth.repeatRegisteredCustomers} ordered more than once`}
            />
            <Figure
              small
              label="Guest orders"
              value={String(growth.guestOrders)}
              note="Ordered without an account"
            />
          </dl>
        </section>
      ) : null}
    </div>
  );
}

function ChecklistText({
  label,
  state,
}: {
  label: string;
  state: ChecklistState;
}) {
  const text =
    state === "completed"
      ? "Done"
      : state === "in-progress"
        ? "In progress"
        : "Not recorded";
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <span className="w-14 text-text-muted">{label}</span>
      <span
        className={`flex items-center gap-1 ${
          state === "not-recorded" ? "text-text-muted" : "text-text-primary"
        }`}
      >
        {state === "completed" ? (
          <IconCheck className="h-3.5 w-3.5 text-accent" />
        ) : null}
        {text}
      </span>
    </span>
  );
}

function OrderingState({ row }: { row: OverviewLocationRow }) {
  if (!row.isActive) {
    return <span className="text-text-muted">Location inactive</span>;
  }
  return row.isDigitalOrderingEnabled ? (
    <span className="text-text-secondary">On</span>
  ) : (
    <span className="flex items-center gap-1.5 font-medium text-status-warning">
      <IconAlert className="h-4 w-4" />
      Off
    </span>
  );
}

// Supporting text under a location name: why it is listed first. Always
// words with an icon, never colour alone, and never a pill.
function Flags({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null;
  return (
    <span className="mt-1 flex items-start gap-1.5 text-sm text-status-warning">
      <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{flags.join(" · ")}</span>
    </span>
  );
}

export function LocationComparison({
  rows,
  hrefFor,
  rangeLabel,
  showChecklists,
}: {
  rows: OverviewLocationRow[];
  hrefFor: (locationId: string) => string;
  rangeLabel: string;
  showChecklists: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-2xl border border-border-default bg-surface-card px-6 py-5 text-sm text-text-secondary">
        No locations to compare yet.
      </p>
    );
  }

  // A flagged row gets a thin leading rule in addition to its words.
  const flaggedRule = (row: OverviewLocationRow) =>
    row.flags.length > 0
      ? { boxShadow: "inset 3px 0 0 var(--status-warning)" }
      : undefined;

  return (
    <div className="overflow-hidden rounded-2xl border border-border-default bg-surface-card">
      {/* Tablet and up: a real table. */}
      <table className="hidden w-full text-left text-[0.9375rem] md:table">
        <caption className="sr-only">
          Digital performance and today&rsquo;s operating state by location
        </caption>
        <thead>
          <tr className="border-b border-border-default text-sm text-text-secondary">
            <th scope="col" className="px-6 py-3.5 font-medium">
              Location
            </th>
            <th scope="col" className="px-4 py-3.5 font-medium">
              Online ordering
            </th>
            <th scope="col" className="px-4 py-3.5 text-right font-medium">
              Orders
              <span className="block text-xs font-normal text-text-muted">
                {rangeLabel}
              </span>
            </th>
            <th scope="col" className="px-4 py-3.5 text-right font-medium">
              Digital sales
            </th>
            <th scope="col" className="px-4 py-3.5 text-right font-medium">
              Avg order
            </th>
            {showChecklists ? (
              <th scope="col" className="px-6 py-3.5 font-medium">
                Checklists today
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-default">
          {rows.map((row) => (
            <tr key={row.locationId} className="align-top">
              <th
                scope="row"
                className="px-6 py-4 font-normal"
                style={flaggedRule(row)}
              >
                <Link
                  href={hrefFor(row.locationId)}
                  className="text-base font-semibold text-text-primary underline-offset-4 hover:underline"
                >
                  {row.name}
                </Link>
                <Flags flags={row.flags} />
              </th>
              <td className="px-4 py-4">
                <OrderingState row={row} />
              </td>
              <td className="px-4 py-4 text-right tabular-nums">
                {row.orders}
              </td>
              <td className="px-4 py-4 text-right tabular-nums">
                {formatPrice(row.salesMinorUnits, CURRENCY)}
              </td>
              <td className="px-4 py-4 text-right tabular-nums">
                {row.orders > 0
                  ? formatPrice(row.averageOrderMinorUnits, CURRENCY)
                  : "—"}
              </td>
              {showChecklists ? (
                <td className="px-6 py-4">
                  {row.checklist ? (
                    <span className="flex flex-col gap-1">
                      <ChecklistText
                        label="Opening"
                        state={row.checklist.opening}
                      />
                      <ChecklistText
                        label="Closing"
                        state={row.checklist.closing}
                      />
                    </span>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Phones: a stacked list, not a squeezed table. */}
      <ul className="divide-y divide-border-default md:hidden">
        {rows.map((row) => (
          <li
            key={row.locationId}
            className="flex flex-col gap-2 px-5 py-4"
            style={flaggedRule(row)}
          >
            <div className="flex items-start justify-between gap-3">
              <Link
                href={hrefFor(row.locationId)}
                className="text-base font-semibold text-text-primary underline-offset-4 hover:underline"
              >
                {row.name}
              </Link>
              <span className="text-sm">
                <OrderingState row={row} />
              </span>
            </div>
            <Flags flags={row.flags} />
            <p className="text-sm text-text-secondary tabular-nums">
              {row.orders} {row.orders === 1 ? "order" : "orders"} ·{" "}
              {formatPrice(row.salesMinorUnits, CURRENCY)}
              {row.orders > 0
                ? ` · ${formatPrice(row.averageOrderMinorUnits, CURRENCY)} avg`
                : ""}
            </p>
            {showChecklists && row.checklist ? (
              <p className="flex flex-col gap-1 text-sm">
                <ChecklistText label="Opening" state={row.checklist.opening} />
                <ChecklistText label="Closing" state={row.checklist.closing} />
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      {showChecklists ? (
        <p className="border-t border-border-default px-5 py-3.5 text-sm leading-snug text-text-secondary sm:px-6">
          Checklist status is today&rsquo;s recorded activity. &ldquo;Not
          recorded&rdquo; means nobody has opened that checklist yet &mdash; not
          that it was missed.
        </p>
      ) : null}
    </div>
  );
}

function formatAge(from: string): string {
  const ms = Date.now() - new Date(from).getTime();
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

// The live queue for one location: how many orders sit at each step, and the
// age of the oldest. Counts come straight from the order queue endpoint.
export function LiveQueue({
  orders,
  href,
}: {
  orders: StoreOrderSummary[];
  href: string;
}) {
  const steps: OrderStatus[] = ["RECEIVED", "ACCEPTED", "PREPARING", "READY"];
  const oldest = orders.reduce<string | null>(
    (acc, o) => (!acc || new Date(o.createdAt) < new Date(acc) ? o.createdAt : acc),
    null,
  );
  return (
    <div className="flex flex-col gap-5 rounded-2xl border border-border-default bg-surface-card p-5 sm:p-6">
      {orders.length === 0 ? (
        <p className="text-sm text-text-secondary">
          The queue is clear &mdash; no active orders right now.
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
          {steps.map((status) => (
            <Figure
              key={status}
              label={ORDER_STATUS_LABEL[status]}
              value={String(orders.filter((o) => o.status === status).length)}
            />
          ))}
        </dl>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="text-text-secondary">
          {oldest
            ? `Oldest active order: ${formatAge(oldest)} ago`
            : "Live from the order queue"}
        </span>
        <Link
          href={href}
          className="flex items-center gap-1.5 font-medium text-text-primary hover:text-accent"
        >
          Open the order queue
          <IconArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}

export interface OperatingFact {
  label: string;
  value: React.ReactNode;
  href?: string;
}

// A short "how is this location running" list for location scope.
export function OperatingState({ facts }: { facts: OperatingFact[] }) {
  return (
    <dl className="divide-y divide-border-default rounded-2xl border border-border-default bg-surface-card">
      {facts.map((fact) => (
        <div
          key={fact.label}
          className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm sm:px-6"
        >
          <dt className="text-text-secondary">{fact.label}</dt>
          <dd className="text-right font-medium text-text-primary">
            {fact.href ? (
              <Link href={fact.href} className="hover:text-accent">
                {fact.value}
              </Link>
            ) : (
              fact.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface ContinueLink {
  label: string;
  description: string;
  href: string;
}

// A restrained "where next" strip: plain links with a small arrow and the
// destination's hint on hover/focus (title). One quiet line, not a launcher.
export function ContinueWorking({ links }: { links: ContinueLink[] }) {
  if (links.length === 0) return null;
  return (
    <nav
      aria-label="Continue working"
      className="-mt-2 flex flex-wrap items-center gap-x-1 gap-y-1"
    >
      <span className="mr-2 text-sm text-text-muted">Go to</span>
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          title={link.description}
          className="group flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-black/[0.045] hover:text-text-primary"
        >
          {link.label}
          <IconArrowRight className="h-3.5 w-3.5 text-text-muted transition-colors group-hover:text-accent" />
        </Link>
      ))}
    </nav>
  );
}
