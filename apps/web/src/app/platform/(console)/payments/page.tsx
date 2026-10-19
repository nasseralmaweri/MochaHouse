import type { Metadata } from "next";
import Link from "next/link";
import { PlatformEmptyState, PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { FilterLinks, NoPermissionPanel } from "@/components/platform/OnboardingFilters";
import { platformInputClassName } from "@/components/platform/PlatformAuthFrame";
import { PaymentCaseCategoryBadge } from "@/components/platform/PaymentCasePanel";
import { getPlatformSession } from "@/lib/platform-auth/session";
import { listPaymentCases } from "@/lib/platform/tenants-api";
import { formatPlatformTime } from "@/lib/platform/onboarding";
import {
  CATEGORY_FILTERS,
  CATEGORY_FILTER_LABEL,
  FAILURE_LABEL,
  PAYMENTS_VIEW_PERMISSION,
  REASON_LABEL,
  formatMinorUnits,
  labelOf,
  paymentCaseApiQuery,
  paymentCaseFilters,
  paymentCaseHref,
} from "@/lib/platform/payment-cases";

export const metadata: Metadata = {
  title: "Payments · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

const LINK =
  "font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const BUTTON =
  "inline-flex min-h-11 items-center rounded-lg border border-border-default px-4 text-sm font-medium text-text-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

// ESP-03 PR 5 — restaurant payment reconciliation cases across businesses
// (payments.reconciliation.view). Newest first; "Needs attention" by default.
// Only references, amounts, states and fixed codes are shown — never card
// data, gift-card codes or customer contact details.
export default async function PlatformPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getPlatformSession();
  const permitted =
    session.state === "signed-in" && session.permissions.includes(PAYMENTS_VIEW_PERMISSION);
  const filters = paymentCaseFilters(await searchParams);
  const header = (
    <PlatformPageHeader
      title="Payments"
      description="Restaurant payments that need reconciliation: a confirmed payment whose order or gift card is missing, or a payment whose outcome is not confirmed yet. A recovery never charges a customer again. Times are in UTC."
    />
  );
  if (!permitted) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <NoPermissionPanel permission={PAYMENTS_VIEW_PERMISSION} area="Payment reconciliation" />
      </div>
    );
  }
  const result = await listPaymentCases(paymentCaseApiQuery(filters));
  const filtered = filters.category !== "all" || filters.tenantId || filters.from || filters.to;

  return (
    <div className="flex flex-col gap-6">
      {header}
      {result.state === "ok" ? (
        <p role="note" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
          Automatic recovery is{" "}
          <strong>{result.data.automaticRecoveryEnabled ? "on" : "off"}</strong> for this deployment.
          {result.data.automaticRecoveryEnabled
            ? " Confirmed payments without their order are retried automatically, with increasing waits."
            : " Recoveries happen only when a customer retries or support asks for one here."}
        </p>
      ) : null}
      <FilterLinks
        label="Case category"
        options={CATEGORY_FILTERS}
        current={filters.category}
        hrefFor={(category) => paymentCaseHref({ ...filters, category })}
        labels={CATEGORY_FILTER_LABEL}
      />
      <form method="get" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="category" value={filters.category} />
        <label className="flex flex-col gap-1 text-sm text-text-primary">
          Business id
          <input
            type="text"
            name="tenantId"
            defaultValue={filters.tenantId}
            autoComplete="off"
            spellCheck={false}
            className={platformInputClassName}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-text-primary">
          Opened from
          <input type="date" name="from" defaultValue={filters.from} className={platformInputClassName} />
        </label>
        <label className="flex flex-col gap-1 text-sm text-text-primary">
          Opened to
          <input type="date" name="to" defaultValue={filters.to} className={platformInputClassName} />
        </label>
        <button type="submit" className={BUTTON}>
          Apply
        </button>
        {filters.tenantId || filters.from || filters.to ? (
          <Link href={paymentCaseHref({ ...filters, tenantId: "", from: "", to: "" })} className={LINK}>
            Clear
          </Link>
        ) : null}
      </form>

      {result.state !== "ok" ? (
        <RegistryStatePanel state={result.state} retryHref={paymentCaseHref(filters)} />
      ) : result.data.cases.length === 0 ? (
        filtered ? (
          <PlatformEmptyState title="No cases match">
            Try another category, business or date range.
          </PlatformEmptyState>
        ) : (
          <PlatformEmptyState title="No payment cases">
            Payments that need reconciliation will appear here.
          </PlatformEmptyState>
        )
      ) : (
        <>
          <p role="status" className="text-sm text-text-secondary">
            {result.data.cases.length} case{result.data.cases.length === 1 ? "" : "s"}
            {result.data.truncated ? " shown — more match; narrow the filters to see them" : ""}
          </p>
          <ul className="flex flex-col gap-3">
            {result.data.cases.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-2 rounded-2xl border border-border-default bg-surface-card p-5 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/platform/payments/${row.id}`} className={LINK}>
                    {row.tenant.name} · {formatMinorUnits(row.payment.amountMinorUnits, row.payment.currency)}
                  </Link>
                  <PaymentCaseCategoryBadge category={row.category} />
                </div>
                <p className="text-text-secondary">{labelOf(REASON_LABEL, row.reasonCode)}</p>
                {row.recovery.lastFailure ? (
                  <p className="text-status-warning">{labelOf(FAILURE_LABEL, row.recovery.lastFailure)}</p>
                ) : null}
                <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[11rem_1fr]">
                  <dt className="text-text-secondary">Opened</dt>
                  <dd className="text-text-primary">{formatPlatformTime(row.createdAt)}</dd>
                  <dt className="text-text-secondary">Payment</dt>
                  <dd className="break-all font-mono text-text-primary">{row.payment.id}</dd>
                  <dt className="text-text-secondary">Order</dt>
                  <dd className="text-text-primary">
                    {row.order
                      ? row.order.orderNumber
                      : row.giftCardPurchase
                        ? row.giftCardPurchase.issued
                          ? "Gift card issued"
                          : "Gift card not issued"
                        : "None"}
                  </dd>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
