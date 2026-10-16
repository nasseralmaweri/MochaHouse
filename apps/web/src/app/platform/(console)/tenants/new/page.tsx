import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { ProvisionTenantForm } from "@/components/platform/ProvisionTenantForm";

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
        description="Creates the business with its built-in staff roles and its first owner. It starts with no locations, ordering, payments, storefront or subscription."
      />
      <ProvisionTenantForm key={operationKey} operationKey={operationKey} />
    </div>
  );
}
