import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import {
  getAdminPromotions,
  getPromotionOptions,
} from "@/lib/internal-auth/admin-promotions";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { PromotionsManager } from "@/components/admin/PromotionsManager";

// Admin → Promotions (Milestone 7E). The regular merchandise-discount
// system — Promotions (apply automatically) and Coupons (need a code).
// Separate from Mocha Bean rewards and Bonus Mocha Bean Promotions.
// `promotions.configure` is CORPORATE-only and the API enforces it.
export default async function AdminPromotionsPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const caps = session.authorization.capabilities;
  const header = (
    <AdminPageHeader
      title="Promotions & Coupons"
      description="Discounts on merchandise. Promotions apply automatically; Coupons need a code."
      breadcrumbs={[{ label: "Promotions" }]}
    />
  );

  if (!can(caps, "promotions.configure")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const [promotionsResult, optionsResult] = await Promise.all([
    getAdminPromotions(),
    getPromotionOptions(),
  ]);

  if (
    promotionsResult.outcome === "unauthenticated" ||
    optionsResult.outcome === "unauthenticated"
  ) {
    redirect("/internal/sign-in");
  }
  if (promotionsResult.outcome === "forbidden") {
    return (
      <AdminPage>
        {header}
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
        <AdminErrorState description="Couldn't load promotions just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <PromotionsManager
        initialPromotions={promotionsResult.data.promotions}
        options={optionsResult.data}
      />
    </AdminPage>
  );
}
