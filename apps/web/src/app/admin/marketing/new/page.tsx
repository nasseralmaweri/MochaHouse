import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminCampaignOptions } from "@/lib/internal-auth/admin-marketing";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminForbidden } from "@/components/admin/states";
import { CampaignCreateForm } from "@/components/admin/CampaignCreateForm";

// Admin → Marketing → New campaign (Milestone 8G). Requires
// `marketing.manage` — a Marketing user with only `marketing.view` cannot
// reach this page.
export default async function AdminNewCampaignPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const caps = session.authorization.capabilities;
  const header = (
    <AdminPageHeader
      title="New campaign"
      breadcrumbs={[
        { label: "Marketing", href: "/admin/marketing" },
        { label: "New campaign" },
      ]}
    />
  );

  if (!can(caps, "marketing.manage")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const optionsResult = await getAdminCampaignOptions();
  if (optionsResult.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }

  return (
    <AdminPage>
      {header}
      <CampaignCreateForm
        options={optionsResult.outcome === "success" ? optionsResult.data : null}
        canUploadMedia={can(caps, "media.manage")}
      />
    </AdminPage>
  );
}
