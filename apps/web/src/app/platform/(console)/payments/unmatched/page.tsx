import type { Metadata } from "next";
import Link from "next/link";
import { PlatformEmptyState, PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { NoPermissionPanel } from "@/components/platform/OnboardingFilters";
import { getPlatformSession } from "@/lib/platform-auth/session";
import { listUnmatchedPaymentEvents } from "@/lib/platform/tenants-api";
import { formatPlatformTime } from "@/lib/platform/onboarding";
import { PAYMENTS_VIEW_PERMISSION } from "@/lib/platform/payment-cases";

export const metadata: Metadata = {
  title: "Unmatched Stripe events · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

const LINK =
  "font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

// ESP-04 M4a — verified Stripe payment events for one of our connected
// accounts that named no payment of that business when they arrived
// (payments.reconciliation.view; read-only). Payment recovery reconciles
// one automatically as soon as a payment of that business names its intent;
// the rest are here for support to investigate. Ids, type and time only.
export default async function UnmatchedPaymentEventsPage() {
  const session = await getPlatformSession();
  const permitted =
    session.state === "signed-in" && session.permissions.includes(PAYMENTS_VIEW_PERMISSION);
  const header = (
    <PlatformPageHeader
      title="Unmatched Stripe events"
      description="Verified Stripe payment events on a restaurant's connected account that named no payment of that business. Nothing is linked from an event's own data. Times are in UTC."
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
  const result = await listUnmatchedPaymentEvents();
  return (
    <div className="flex flex-col gap-6">
      {header}
      <Link href="/platform/payments" className={LINK}>
        Back to payment cases
      </Link>
      {result.state !== "ok" ? (
        <RegistryStatePanel state={result.state} retryHref="/platform/payments/unmatched" />
      ) : result.data.events.length === 0 ? (
        <PlatformEmptyState title="No unmatched events">
          Stripe payment events that name no payment will appear here.
        </PlatformEmptyState>
      ) : (
        <>
          <p role="status" className="text-sm text-text-secondary">
            {result.data.events.length} event{result.data.events.length === 1 ? "" : "s"}
            {result.data.truncated ? " shown — the newest only" : ""}
          </p>
          <ul className="flex flex-col gap-3">
            {result.data.events.map((event) => (
              <li
                key={event.id}
                className="flex flex-col gap-2 rounded-2xl border border-border-default bg-surface-card p-5 text-sm"
              >
                <p className="font-medium text-text-primary">
                  {event.tenant ? event.tenant.name : "Not one of our businesses"} · {event.type}
                </p>
                <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[11rem_1fr]">
                  <dt className="text-text-secondary">Received</dt>
                  <dd className="text-text-primary">{formatPlatformTime(event.receivedAt)}</dd>
                  <dt className="text-text-secondary">Payment intent</dt>
                  <dd className="break-all font-mono text-text-primary">{event.paymentIntentId ?? "—"}</dd>
                  <dt className="text-text-secondary">Connected account</dt>
                  <dd className="break-all font-mono text-text-primary">{event.connectedAccountId ?? "—"}</dd>
                  <dt className="text-text-secondary">Reconciliation tries</dt>
                  <dd className="text-text-primary">{event.attempts}</dd>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
