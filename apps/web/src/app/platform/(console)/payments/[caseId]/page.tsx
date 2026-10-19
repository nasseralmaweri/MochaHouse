import type { Metadata } from "next";
import Link from "next/link";
import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { NoPermissionPanel } from "@/components/platform/OnboardingFilters";
import { PaymentCasePanel } from "@/components/platform/PaymentCasePanel";
import { getPlatformSession } from "@/lib/platform-auth/session";
import { getPaymentCase } from "@/lib/platform/tenants-api";
import {
  PAYMENTS_MANAGE_PERMISSION,
  PAYMENTS_VIEW_PERMISSION,
  validCaseId,
} from "@/lib/platform/payment-cases";

export const metadata: Metadata = {
  title: "Payment case · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

// ESP-03 PR 5 — one restaurant payment case (payments.reconciliation.view):
// references, recovery history and internal notes. Recovery requests and
// notes need payments.reconciliation.manage; the API re-checks both and a
// recent sign-in on every change.
export default async function PlatformPaymentCasePage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  const session = await getPlatformSession();
  const permissions = session.state === "signed-in" ? session.permissions : [];
  const back = (
    <Link
      href="/platform/payments"
      className="w-fit text-sm font-medium text-text-secondary underline-offset-4 hover:text-text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
    >
      ← Back to payments
    </Link>
  );
  const header = (
    <PlatformPageHeader
      title="Payment case"
      description="A restaurant payment that needs reconciliation. Times are in UTC."
    />
  );
  if (!permissions.includes(PAYMENTS_VIEW_PERMISSION)) {
    return (
      <div className="flex flex-col gap-6">
        {back}
        {header}
        <NoPermissionPanel permission={PAYMENTS_VIEW_PERMISSION} area="Payment reconciliation" />
      </div>
    );
  }
  if (!validCaseId(caseId)) {
    return (
      <div className="flex flex-col gap-6">
        {back}
        {header}
        <RegistryStatePanel state="not-found" retryHref="/platform/payments" />
      </div>
    );
  }
  const result = await getPaymentCase(caseId);
  return (
    <div className="flex flex-col gap-6">
      {back}
      {header}
      {result.state === "ok" ? (
        <PaymentCasePanel
          detail={result.data}
          canManage={permissions.includes(PAYMENTS_MANAGE_PERMISSION)}
        />
      ) : (
        <RegistryStatePanel state={result.state} retryHref={`/platform/payments/${caseId}`} />
      )}
    </div>
  );
}
