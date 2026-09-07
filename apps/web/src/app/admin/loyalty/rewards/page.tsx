import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import {
  getAdminLoyaltyRewards,
  getLoyaltyCatalogOptions,
} from "@/lib/internal-auth/admin-loyalty";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { LoyaltyTabs } from "@/components/admin/LoyaltyTabs";
import { RewardsManager } from "@/components/admin/RewardsManager";

// Admin → Loyalty → Rewards (Milestone 7B). The customer Rewards Catalog.
// Catalog management only — no redemption. `loyalty.configure` is
// CORPORATE-only and the API enforces it.
export default async function AdminLoyaltyRewardsPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const caps = session.authorization.capabilities;
  const header = (
    <AdminPageHeader
      title="Rewards"
      description="Rewards customers can redeem with Mocha Beans. Redemption ships in a later slice."
      breadcrumbs={[
        { label: "Loyalty", href: "/admin/loyalty" },
        { label: "Rewards" },
      ]}
    />
  );

  if (!can(caps, "loyalty.configure")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const [rewardsResult, catalogResult] = await Promise.all([
    getAdminLoyaltyRewards(),
    getLoyaltyCatalogOptions(),
  ]);

  if (
    rewardsResult.outcome === "unauthenticated" ||
    catalogResult.outcome === "unauthenticated"
  ) {
    redirect("/internal/sign-in");
  }

  const tabs = (
    <LoyaltyTabs
      active="rewards"
      canView={can(caps, "loyalty.view")}
      canConfigure
    />
  );

  if (rewardsResult.outcome === "forbidden") {
    return (
      <AdminPage>
        {header}
        {tabs}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (
    rewardsResult.outcome === "error" ||
    catalogResult.outcome !== "success"
  ) {
    return (
      <AdminPage>
        {header}
        {tabs}
        <AdminErrorState description="Couldn't load the Rewards Catalog just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      {tabs}
      <RewardsManager
        initialRewards={rewardsResult.data.rewards}
        catalog={catalogResult.data}
      />
    </AdminPage>
  );
}
