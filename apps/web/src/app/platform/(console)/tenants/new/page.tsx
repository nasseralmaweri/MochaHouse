import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { ProvisionTenantForm } from "@/components/platform/ProvisionTenantForm";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { listPlatformPlans } from "@/lib/platform/tenants-api";
import { assignableVersions } from "@/lib/platform/subscriptions";

export const metadata: Metadata = {
  title: "Add a business · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

// SC1d — create a business and its first owner. One operation key per visit
// (rendered per request, never prerendered): retries and double submits of
// this form are the same operation, so they can never create two businesses.
export default async function PlatformAddTenantPage() {
  await connection();
  const operationKey = randomUUID();
  // SC2a — a new business must start on a published plan.
  const plans = await listPlatformPlans();
  const versions = plans.state === "ok" ? assignableVersions(plans.data.plans) : [];

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Link
        href="/platform/tenants"
        className="w-fit text-sm font-medium text-text-secondary underline-offset-4 hover:text-text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
      >
        ← All tenants
      </Link>
      <PlatformPageHeader
        title="Add a business"
        description="Creates the business with its built-in staff roles, its first owner and its plan. It starts with no locations, ordering, payments or storefront."
      />
      {plans.state !== "ok" ? (
        <RegistryStatePanel state={plans.state} retryHref="/platform/tenants/new" />
      ) : versions.length === 0 ? (
        <p role="status" className="rounded-2xl border border-border-default bg-surface-card p-5 text-sm text-text-primary">
          No published plan yet. <Link href="/platform/plans" className="font-medium underline underline-offset-4">Publish a plan</Link> before adding a business.
        </p>
      ) : (
        <ProvisionTenantForm key={operationKey} operationKey={operationKey} plans={versions} />
      )}
    </div>
  );
}
