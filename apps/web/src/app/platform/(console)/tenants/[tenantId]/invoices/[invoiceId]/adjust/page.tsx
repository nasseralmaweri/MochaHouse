import type { Metadata } from "next";
import Link from "next/link";
import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { AdjustmentRequestForm } from "@/components/platform/AdjustmentRequestForm";
import { getPlatformAdjustableInvoice } from "@/lib/platform/tenants-api";
import { getPlatformSession } from "@/lib/platform-auth/session";
import { isTenantId } from "@/lib/platform/tenant-registry";
import { money } from "@/lib/platform/adjustments";

export const metadata: Metadata = {
  title: "Refund or credit an invoice · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// SC3e-3 — requesting a refund or credit on one of a business's paid
// CENTERIVO invoices (billing.adjustments.request). The invoice is read live
// from the payment provider.
export default async function AdjustInvoicePage({
  params,
}: {
  params: Promise<{ tenantId: string; invoiceId: string }>;
}) {
  const { tenantId, invoiceId } = await params;
  const valid = isTenantId(tenantId) && UUID.test(invoiceId);
  const back = (
    <Link
      href={valid ? `/platform/tenants/${tenantId}` : "/platform/tenants"}
      className="text-sm font-medium text-text-primary underline underline-offset-2"
    >
      Back to the business
    </Link>
  );
  if (!valid) {
    return (
      <div className="flex flex-col gap-6">
        {back}
        <PlatformPageHeader title="Refund or credit" />
        <RegistryStatePanel state="not-found" />
      </div>
    );
  }
  const session = await getPlatformSession();
  const permissions = session.state === "signed-in" ? session.permissions : [];
  if (!permissions.includes("billing.adjustments.request")) {
    return (
      <div className="flex flex-col gap-6">
        {back}
        <PlatformPageHeader title="Refund or credit" />
        <p className="rounded-2xl border border-border-default bg-surface-card p-5 text-sm text-text-secondary">
          Requesting a refund or credit needs billing.adjustments.request. Ask a CENTERIVO administrator.
        </p>
      </div>
    );
  }
  const result = await getPlatformAdjustableInvoice(tenantId, invoiceId);
  if (result.state !== "ok") {
    return (
      <div className="flex flex-col gap-6">
        {back}
        <PlatformPageHeader title="Refund or credit" />
        <RegistryStatePanel state={result.state} retryHref={`/platform/tenants/${tenantId}/invoices/${invoiceId}/adjust`} />
      </div>
    );
  }
  const invoice = result.data;
  return (
    <div className="flex flex-col gap-6">
      {back}
      <PlatformPageHeader
        title={`Refund or credit ${invoice.number ?? "this invoice"}`}
        description="As the payment provider holds it now (Stripe test mode). Nothing changes until other operators approve."
      />
      <dl className="grid gap-x-4 gap-y-1 rounded-2xl border border-border-default bg-surface-card p-5 text-sm sm:grid-cols-3">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-text-secondary">Paid</dt>
          <dd className="text-text-primary">{money(invoice.amountPaidMinorUnits, invoice.currency)}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-text-secondary">Already refunded or credited</dt>
          <dd className="text-text-primary">{money(invoice.adjustedMinorUnits, invoice.currency)}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-text-secondary">Can still be refunded or credited</dt>
          <dd className="font-semibold text-text-primary">{money(invoice.remainingMinorUnits, invoice.currency)}</dd>
        </div>
      </dl>
      {invoice.remainingMinorUnits > 0 ? (
        <AdjustmentRequestForm tenantId={tenantId} invoice={invoice} />
      ) : (
        <p className="rounded-2xl border border-border-default bg-surface-card p-5 text-sm text-text-secondary">
          Nothing remains to refund or credit on this invoice.
        </p>
      )}
    </div>
  );
}
