import type {
  PlatformRevenueReport,
  RevenueMetricStatus,
  RevenueReportEnvironment,
} from "@mocha-house/contracts";
import { formatMinorUnits } from "@/lib/admin/crm";

// SC3f — CENTERIVO SaaS revenue reporting in the console (pure helpers:
// wording, periods, rates). Every figure comes from the API, per currency;
// nothing here combines currencies or fills in missing data.

export const ENVIRONMENT_LABELS: Record<RevenueReportEnvironment, string> = {
  STRIPE_TEST_MODE: "Stripe Test Mode",
  STRIPE_LIVE_MODE: "Stripe Live Mode",
  DEVELOPMENT: "Development (simulated payment provider)",
  NO_PROVIDER: "No payment provider configured",
};

export const STATUS_LABELS: Record<RevenueMetricStatus, string> = {
  COMPLETE: "Complete",
  INCOMPLETE: "Incomplete — some billing history is missing; figures count only what is known",
  UNAVAILABLE: "Unavailable",
};

export const VIOLATION_LABELS: Record<string, string> = {
  INVOICE_AMOUNTS_DONT_ADD_UP: "Invoices whose total isn't the total before tax plus tax",
  INVOICE_PAID_MORE_THAN_TOTAL: "Invoices paid for more than their total",
  ADJUSTMENTS_EXCEED_PAID: "Invoices refunded or credited for more than was paid",
  PLAN_BREAKDOWN_MISMATCH: "The plan breakdown doesn't add up to the totals",
  PRICE_NOT_FOUND: "Subscriptions whose price couldn't be found",
};

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const MAX_MONTHS = 24;

export function money(minorUnits: number, currency: string): string {
  return formatMinorUnits(minorUnits, currency);
}

export function monthLabel(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// "4.2%", or "—" without a denominator.
export function rate(numerator: number, denominator: number): string {
  if (denominator <= 0) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

// The months offered in the period filter: the last 24 including this one,
// newest first (UTC).
export function monthOptions(now: Date): string[] {
  const out: string[] = [];
  for (let i = 0; i < MAX_MONTHS; i++) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

// The period asked for in the page address, passed on as asked (short
// values only) so the API refuses a malformed one visibly — never silently
// replaced by another period.
export function periodParams(params: { from?: string | string[]; to?: string | string[] }): {
  from?: string;
  to?: string;
} {
  const one = (value: string | string[] | undefined) =>
    typeof value === "string" && value.length > 0 && value.length <= 10 ? value : undefined;
  const from = one(params.from);
  const to = one(params.to);
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

export function isMonth(value: string | undefined): boolean {
  return value !== undefined && MONTH.test(value);
}

// The page address for a period (for retry links).
export function periodHref(period: { from?: string; to?: string }): string {
  const query = new URLSearchParams(period as Record<string, string>).toString();
  return `/platform/billing/revenue${query ? `?${query}` : ""}`;
}

export function periodLabel(report: Pick<PlatformRevenueReport, "period">): string {
  const { from, to } = report.period;
  return from === to ? monthLabel(from) : `${monthLabel(from)} – ${monthLabel(to)}`;
}

// Every currency appearing anywhere in the report, sorted.
export function currenciesOf(report: PlatformRevenueReport): string[] {
  const set = new Set<string>();
  for (const r of report.current.recurring) set.add(r.currency);
  for (const m of report.months) {
    for (const r of m.recurring) set.add(r.currency);
    for (const c of m.cash) set.add(c.currency);
  }
  return [...set].sort();
}

// A bar's width (percent of the largest value in the series).
export function barWidth(value: number, max: number): string {
  if (max <= 0 || value <= 0) return "0%";
  return `${Math.max(2, Math.round((value / max) * 100))}%`;
}
