import type { Metadata } from "next";
import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { PlansManager } from "@/components/platform/PlansManager";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { listPlatformPlans } from "@/lib/platform/tenants-api";

export const metadata: Metadata = {
  title: "Plans · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

// SC2a — CENTERIVO SaaS plans and their versions. A plan decides which
// modules a business can use (core is always included). No prices or
// billing yet: plans are separate from a business's customer payments.
export default async function PlatformPlansPage() {
  const plans = await listPlatformPlans();
  return (
    <div className="flex flex-col gap-6">
      <PlatformPageHeader
        title="Plans"
        description="Which modules a business can use. A published version is frozen; change a plan by publishing a new version. No prices or billing yet."
      />
      {plans.state !== "ok" ? (
        <RegistryStatePanel state={plans.state} retryHref="/platform/plans" />
      ) : (
        <>
          <p className="text-sm text-text-secondary">
            {plans.data.subscriptions.total}{" "}
            {plans.data.subscriptions.total === 1 ? "business has" : "businesses have"} a subscription.
          </p>
          <PlansManager plans={plans.data.plans} />
        </>
      )}
    </div>
  );
}
