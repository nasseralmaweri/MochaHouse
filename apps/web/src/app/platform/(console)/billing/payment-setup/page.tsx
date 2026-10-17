import type { Metadata } from "next";
import Link from "next/link";
import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { listPlatformPaymentSetup } from "@/lib/platform/tenants-api";

export const metadata: Metadata = {
  title: "Awaiting payment setup · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

const when = (iso: string) =>
  `${new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;

// SC3e-4 — billed businesses that still need payment setup: since when,
// their deadline (only while billing enforcement is on) and extensions.
// Deadlines are extended on the business's page.
export default async function PlatformPaymentSetupPage() {
  const result = await listPlatformPaymentSetup();
  return (
    <div className="flex flex-col gap-6">
      <Link href="/platform/billing" className="text-sm font-medium text-text-primary underline underline-offset-2">
        Back to billing
      </Link>
      <PlatformPageHeader
        title="Awaiting payment setup"
        description="Billed businesses without a confirmed, paid subscription. With billing enforcement on, each has 14 days (extendable to 30) before it is paused for billing."
      />
      {result.state !== "ok" ? (
        <RegistryStatePanel state={result.state} retryHref="/platform/billing/payment-setup" />
      ) : (
        <>
          {!result.data.enforced ? (
            <p role="note" className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-text-primary">
              Billing enforcement is off: no deadlines apply and nobody is paused.
            </p>
          ) : null}
          {result.data.items.length === 0 ? (
            <p className="rounded-2xl border border-border-default bg-surface-card p-5 text-sm text-text-secondary">
              No business is waiting for payment setup.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {result.data.items.map((item) => (
                <li key={item.tenantId} className="flex flex-col gap-1 rounded-2xl border border-border-default bg-surface-card p-5 text-sm">
                  <Link href={`/platform/tenants/${item.tenantId}`} className="font-semibold text-text-primary underline underline-offset-2">
                    {item.businessName}
                  </Link>
                  <p className="text-text-primary">
                    {item.planName} · needed since {when(item.since)}
                  </p>
                  <p className={item.expired ? "font-medium text-status-error" : "text-text-primary"}>
                    {item.expired
                      ? "Deadline passed — paused for billing until payment is set up"
                      : item.deadline
                        ? `Deadline ${when(item.deadline)}`
                        : result.data.enforced
                          ? "Deadline set at the next billing sweep"
                          : "No deadline (enforcement off)"}
                  </p>
                  {item.extensions.length > 0 ? (
                    <p className="text-text-secondary">
                      Extended {item.extensions.length} time{item.extensions.length === 1 ? "" : "s"} (latest by{" "}
                      {item.extensions[item.extensions.length - 1].operatorEmail})
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
