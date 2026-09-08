import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import {
  getAdminLoyaltyBonusPromotions,
  getLoyaltyBonusPromotionOptions,
} from "@/lib/internal-auth/admin-loyalty";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { LoyaltyTabs } from "@/components/admin/LoyaltyTabs";
import { BonusPromotionsManager } from "@/components/admin/BonusPromotionsManager";

// Admin → Loyalty → Bonus promotions (Milestone 7D). Deliberately simple
// product-based Mocha Bean bonus campaigns — no discounts, no rules engine.
// `loyalty.configure` is CORPORATE-only and the API enforces it.
export default async function AdminLoyaltyBonusPromotionsPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const caps = session.authorization.capabilities;
  const header = (
    <AdminPageHeader
      title="Bonus promotions"
      description="Award extra Mocha Beans on chosen products. No discounts — Beans only."
      breadcrumbs={[
        { label: "Loyalty", href: "/admin/loyalty" },
        { label: "Bonus promotions" },
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

  const [promotionsResult, optionsResult] = await Promise.all([
    getAdminLoyaltyBonusPromotions(),
    getLoyaltyBonusPromotionOptions(),
  ]);

  if (
    promotionsResult.outcome === "unauthenticated" ||
    optionsResult.outcome === "unauthenticated"
  ) {
    redirect("/internal/sign-in");
  }

  const tabs = (
    <LoyaltyTabs
      active="bonus-promotions"
      canView={can(caps, "loyalty.view")}
      canConfigure
    />
  );

  if (promotionsResult.outcome === "forbidden") {
    return (
      <AdminPage>
        {header}
        {tabs}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (
    promotionsResult.outcome === "error" ||
    optionsResult.outcome !== "success"
  ) {
    return (
      <AdminPage>
        {header}
        {tabs}
        <AdminErrorState description="Couldn't load bonus promotions just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      {tabs}
      <BonusPromotionsManager
        initialPromotions={promotionsResult.data.promotions}
        options={optionsResult.data}
      />
    </AdminPage>
  );
}
