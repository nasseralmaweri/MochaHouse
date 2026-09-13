import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import {
  getAdminCampaign,
  getAdminCampaignOptions,
} from "@/lib/internal-auth/admin-marketing";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { CampaignEditor } from "@/components/admin/CampaignEditor";

export default async function AdminCampaignPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }
  const { campaignId } = await params;
  const caps = session.authorization.capabilities;

  const header = (title: string) => (
    <AdminPageHeader
      title={title}
      breadcrumbs={[
        { label: "Marketing", href: "/admin/marketing" },
        { label: title },
      ]}
    />
  );

  if (!can(caps, "marketing.view")) {
    return (
      <AdminPage>
        {header("Campaign")}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const [campaignResult, optionsResult] = await Promise.all([
    getAdminCampaign(campaignId),
    getAdminCampaignOptions(),
  ]);

  if (campaignResult.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (campaignResult.outcome === "forbidden") {
    return (
      <AdminPage>
        {header("Campaign")}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (campaignResult.outcome === "not-found") {
    return (
      <AdminPage>
        {header("Campaign")}
        <AdminNotFound
          description="This campaign doesn't exist."
          backHref="/admin/marketing"
          backLabel="Back to all campaigns"
        />
      </AdminPage>
    );
  }
  if (campaignResult.outcome === "error") {
    return (
      <AdminPage>
        {header("Campaign")}
        <AdminErrorState description="Couldn't load this campaign just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header(campaignResult.data.name)}
      <CampaignEditor
        initial={campaignResult.data}
        options={optionsResult.outcome === "success" ? optionsResult.data : null}
        canManage={can(caps, "marketing.manage")}
        canUploadMedia={can(caps, "media.manage")}
      />
    </AdminPage>
  );
}
