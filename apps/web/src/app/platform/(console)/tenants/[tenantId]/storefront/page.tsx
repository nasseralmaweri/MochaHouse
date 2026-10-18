import type { Metadata } from "next";
import Link from "next/link";
import { PlatformPageHeader } from "@/components/platform/PlatformCards";
import { RegistryStatePanel } from "@/components/platform/TenantRegistry";
import { StorefrontPanel } from "@/components/platform/StorefrontPanel";
import { getPlatformSession } from "@/lib/platform-auth/session";
import { getTenantStorefront } from "@/lib/platform/tenants-api";
import { isTenantId } from "@/lib/platform/tenant-registry";
import { STOREFRONT_MANAGE_PERMISSION } from "@/lib/platform/storefront";

export const metadata: Metadata = {
  title: "Storefront · CENTERIVO Platform Console",
  robots: { index: false, follow: false },
};

// SC4f-3a — one business's storefront: its approved addresses, whether each
// is published in the registry and actually live, the publishing checks, and
// the history. storefront.manage to see or change it; the API re-checks the
// permission, a recent sign-in, the reason and the slug on every change.
export default async function PlatformTenantStorefrontPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const session = await getPlatformSession();
  const permissions = session.state === "signed-in" ? session.permissions : [];
  const back = (
    <Link
      href={isTenantId(tenantId) ? `/platform/tenants/${tenantId}` : "/platform/tenants"}
      className="w-fit text-sm font-medium text-text-secondary underline-offset-4 hover:text-text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
    >
      ← Back to the business
    </Link>
  );
  const header = (
    <PlatformPageHeader
      title="Storefront"
      description="The business's approved storefront addresses: assign, publish and unpublish them. Publishing here does not make a storefront public while host routing is off."
    />
  );

  if (!isTenantId(tenantId)) {
    return (
      <div className="flex flex-col gap-6">
        {back}
        {header}
        <RegistryStatePanel state="not-found" retryHref="/platform/tenants" />
      </div>
    );
  }
  if (!permissions.includes(STOREFRONT_MANAGE_PERMISSION)) {
    return (
      <div className="flex flex-col gap-6">
        {back}
        {header}
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-2xl border border-border-default bg-surface-card p-6"
        >
          <h2 className="text-base font-semibold text-text-primary">Access denied</h2>
          <p className="max-w-prose text-sm text-text-secondary">
            Managing storefronts needs the {STOREFRONT_MANAGE_PERMISSION} permission. Ask a CENTERIVO
            administrator to grant it.
          </p>
        </div>
      </div>
    );
  }

  const result = await getTenantStorefront(tenantId);
  return (
    <div className="flex flex-col gap-6">
      {back}
      {header}
      {result.state !== "ok" ? (
        <RegistryStatePanel
          state={result.state}
          retryHref={`/platform/tenants/${tenantId}/storefront`}
        />
      ) : (
        <StorefrontPanel view={result.data} />
      )}
    </div>
  );
}
