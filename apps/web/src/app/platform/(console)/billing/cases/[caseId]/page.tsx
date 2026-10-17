import type { Metadata } from "next";
import Link from "next/link";
import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { CaseActionsPanel } from "@/components/platform/CaseActions";
import { getPlatformCase } from "@/lib/platform/tenants-api";
import { getPlatformSession } from "@/lib/platform-auth/session";
import { CASE_LABELS } from "@/lib/platform/billing-case-labels";
import { CASE_ACTION_LABELS, CASE_OUTCOME_LABELS, holds } from "@/lib/platform/complimentary";

export const metadata: Metadata = {
  title: "Billing case · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// SC3e-2 — one billing review case: what it is, its action history, what the
// payment provider holds now, and the actions this operator may take
// (recheck, release a leftover schedule, close with an outcome). Nothing here
// refunds, credits or adopts a provider price.
export default async function PlatformCasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const back = (
    <Link href="/platform/billing" className="text-sm font-medium text-text-primary underline underline-offset-2">
      Back to billing
    </Link>
  );
  if (!UUID.test(caseId)) {
    return (
      <div className="flex flex-col gap-6">
        {back}
        <PlatformPageHeader title="Billing case" />
        <RegistryStatePanel state="not-found" />
      </div>
    );
  }
  const [result, session] = await Promise.all([getPlatformCase(caseId), getPlatformSession()]);
  const permissions = session.state === "signed-in" ? session.permissions : [];
  if (result.state !== "ok") {
    return (
      <div className="flex flex-col gap-6">
        {back}
        <PlatformPageHeader title="Billing case" />
        <RegistryStatePanel state={result.state} retryHref={`/platform/billing/cases/${caseId}`} />
      </div>
    );
  }
  const { case: item, actions, provider, providerUnavailable } = result.data;
  const open = item.status === "OPEN";
  const canCases = holds(permissions, "billing.cases.manage");
  const canRelease = holds(permissions, "billing.schedules.release");
  const releasable = open && provider?.schedule && !provider.scheduleIsOpenPlanChange;
  return (
    <div className="flex flex-col gap-6">
      {back}
      <PlatformPageHeader
        title={CASE_LABELS[item.kind] ?? item.kind}
        description={open ? "Open — to review." : "Closed."}
      />
      <section className="flex flex-col gap-2 rounded-2xl border border-border-default bg-surface-card p-5 text-sm">
        {item.tenantId ? (
          <Link href={`/platform/tenants/${item.tenantId}`} className="font-medium text-text-primary underline underline-offset-2">
            {item.businessName ?? "Business"}
          </Link>
        ) : null}
        {item.detail ? <p className="break-words text-text-secondary">{item.detail}</p> : null}
        <p className="text-xs text-text-secondary">Opened {new Date(item.createdAt).toLocaleString("en-US")}</p>
        {item.resolutionOutcome ? (
          <p className="text-text-primary">
            Closed as {CASE_OUTCOME_LABELS[item.resolutionOutcome]}: {item.resolutionNote}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="case-provider" className="flex flex-col gap-2 rounded-2xl border border-border-default bg-surface-card p-5 text-sm">
        <h2 id="case-provider" className="text-base font-semibold text-text-primary">
          At the payment provider now
        </h2>
        {providerUnavailable ? (
          <p className="text-text-secondary">The payment provider couldn&apos;t be read right now.</p>
        ) : provider === null ? (
          <p className="text-text-secondary">This case has no billed subscription to read.</p>
        ) : provider.schedule ? (
          <p className="break-words text-text-primary">
            A schedule is attached: <span className="break-all font-mono">{provider.schedule.externalScheduleId}</span> (
            {provider.schedule.status})
            {provider.scheduleIsOpenPlanChange
              ? ". It belongs to an open scheduled plan change; the business cancels that from its billing page."
              : "."}
          </p>
        ) : (
          <p className="text-text-secondary">No schedule is attached to the subscription.</p>
        )}
      </section>

      <CaseActionsPanel
        caseId={item.id}
        open={open}
        canCases={canCases}
        canRelease={canRelease}
        releasableScheduleId={releasable && provider?.schedule ? provider.schedule.externalScheduleId : null}
      />

      <section aria-labelledby="case-history" className="flex flex-col gap-2">
        <h2 id="case-history" className="text-base font-semibold text-text-primary">
          History
        </h2>
        {actions.length === 0 ? (
          <p className="text-sm text-text-secondary">No actions yet.</p>
        ) : (
          <ol className="flex flex-col gap-2 text-sm">
            {actions.map((action, index) => (
              <li key={`${action.at}-${index}`} className="rounded-lg bg-surface-subtle px-3 py-2">
                <p className="font-medium text-text-primary">
                  {CASE_ACTION_LABELS[action.action] ?? action.action} — {action.result}
                </p>
                <p className="break-words text-text-secondary">
                  {action.actor.email} · {new Date(action.at).toLocaleString("en-US")}
                  {action.externalScheduleId ? ` · schedule ${action.externalScheduleId}` : ""}
                </p>
                {action.note ? <p className="break-words text-text-primary">{action.note}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
