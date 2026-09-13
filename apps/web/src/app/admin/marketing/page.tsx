import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminCampaigns } from "@/lib/internal-auth/admin-marketing";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { CampaignsManager } from "@/components/admin/CampaignsManager";

// Admin → Marketing (Milestone 8G). A thin HQ "Campaign Management" layer
// that organizes existing Promotions, Bonus Mocha Bean Promotions, Products
// and Media — it never reimplements any of them. `marketing.view` gates the
// page; create/edit/status actions gate on `marketing.manage`. The API
// enforces both.
export default async function AdminMarketingPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const caps = session.authorization.capabilities;
  const header = (
    <AdminPageHeader
      title="Marketing"
      description="Campaigns organize existing Promotions, Bonus Mocha Bean Promotions, featured products and creative — they never duplicate those systems' own rules."
      breadcrumbs={[{ label: "Marketing" }]}
    />
  );

  if (!can(caps, "marketing.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const campaignsResult = await getAdminCampaigns();

  if (campaignsResult.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (campaignsResult.outcome === "forbidden") {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (campaignsResult.outcome !== "success") {
    return (
      <AdminPage>
        {header}
        <AdminErrorState description="Couldn't load campaigns just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <CampaignsManager
        campaigns={campaignsResult.data.campaigns}
        canManage={can(caps, "marketing.manage")}
      />
    </AdminPage>
  );
}
