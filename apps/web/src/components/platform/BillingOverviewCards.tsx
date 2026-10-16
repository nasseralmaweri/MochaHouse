import type { PlatformBillingOverview } from "@mocha-house/contracts";

// SC3c-3 — what needs a platform operator's attention in billing. Counts
// only (no external paging); the cases below hold the detail.
export function BillingOverviewCards({
  overview,
  caseLabels,
}: {
  overview: PlatformBillingOverview;
  caseLabels: Record<string, string>;
}) {
  const metrics: { label: string; value: number; hint: string }[] = [
    { label: "In grace period", value: overview.inGrace, hint: "Payment failed; full access until the grace period ends" },
    { label: "Unpaid", value: overview.unpaid, hint: "Grace period over; invoice still unpaid" },
    { label: "Paused for billing", value: overview.billingSuspended, hint: "Access limited to billing" },
    { label: "Grace exceptions", value: overview.graceExceptions, hint: "Unpaid, with temporary access an operator gave" },
    { label: "Trial recovery", value: overview.trialRecoveryWindows, hint: "Trial ended; short window to subscribe" },
    { label: "Billing contact problems", value: overview.missingContacts, hint: "No one eligible, or the designated contact's email not verified" },
    { label: "Failed billing emails", value: overview.failedNotifications, hint: "Could not be sent after two attempts" },
  ];
  return (
    <section aria-labelledby="billing-overview" className="flex flex-col gap-3">
      <h2 id="billing-overview" className="text-lg font-semibold text-text-primary">
        Needs attention
      </h2>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => (
          <div
            key={metric.label}
            className="flex flex-col gap-1 rounded-2xl border border-border-default bg-surface-card p-4"
          >
            <dt className="text-sm text-text-secondary">{metric.label}</dt>
            <dd className="text-2xl font-semibold text-text-primary">{metric.value}</dd>
            <dd className="text-xs text-text-secondary">{metric.hint}</dd>
          </div>
        ))}
      </dl>
      {overview.openCases.length > 0 ? (
        <div className="rounded-2xl border border-border-default bg-surface-card p-4 text-sm">
          <p className="font-medium text-text-primary">Open cases by kind</p>
          <ul className="mt-2 flex flex-col gap-1 text-text-secondary">
            {overview.openCases.map((item) => (
              <li key={item.kind}>
                {caseLabels[item.kind] ?? item.kind}: <span className="font-medium text-text-primary">{item.count}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
