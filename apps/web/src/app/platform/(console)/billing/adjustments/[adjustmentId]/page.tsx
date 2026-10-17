import type { Metadata } from "next";
import Link from "next/link";
import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { AdjustmentSummary } from "@/components/platform/AdjustmentSummary";
import { AdjustmentDecision } from "@/components/platform/AdjustmentDecision";
import { getPlatformAdjustment } from "@/lib/platform/tenants-api";
import { getPlatformSession } from "@/lib/platform-auth/session";
import { ADJUSTMENT_STATUS_LABELS, adjustmentActions } from "@/lib/platform/adjustments";

export const metadata: Metadata = {
  title: "Refund or credit · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// SC3e-3 — one refund or credit: its details and history, and what this
// operator may do (decide, withdraw its own request, resolve a reviewed one).
export default async function PlatformAdjustmentPage({
  params,
}: {
  params: Promise<{ adjustmentId: string }>;
}) {
  const { adjustmentId } = await params;
  const back = (
    <Link
      href="/platform/billing/adjustments"
      className="text-sm font-medium text-text-primary underline underline-offset-2"
    >
      Back to refunds and credits
    </Link>
  );
  if (!UUID.test(adjustmentId)) {
    return (
      <div className="flex flex-col gap-6">
        {back}
        <PlatformPageHeader title="Refund or credit" />
        <RegistryStatePanel state="not-found" />
      </div>
    );
  }
  const [result, session] = await Promise.all([getPlatformAdjustment(adjustmentId), getPlatformSession()]);
  if (result.state !== "ok") {
    return (
      <div className="flex flex-col gap-6">
        {back}
        <PlatformPageHeader title="Refund or credit" />
        <RegistryStatePanel state={result.state} retryHref={`/platform/billing/adjustments/${adjustmentId}`} />
      </div>
    );
  }
  const view = result.data;
  const actions = adjustmentActions(
    view,
    session.state === "signed-in" ? session.operator.id : null,
    session.state === "signed-in" ? session.permissions : [],
  );
  return (
    <div className="flex flex-col gap-6">
      {back}
      <PlatformPageHeader title={view.kind === "CREDIT" ? "Credit" : "Refund"} description={ADJUSTMENT_STATUS_LABELS[view.status]} />
      <section className="rounded-2xl border border-border-default bg-surface-card p-5">
        <AdjustmentSummary view={view} showHistory />
      </section>
      {actions.decide ? <AdjustmentDecision view={view} mode="decide" /> : null}
      {actions.cancel ? <AdjustmentDecision view={view} mode="cancel" /> : null}
      {actions.resolve ? <AdjustmentDecision view={view} mode="resolve" /> : null}
      {actions.reason ? <p className="text-sm text-text-secondary">{actions.reason}</p> : null}
    </div>
  );
}
