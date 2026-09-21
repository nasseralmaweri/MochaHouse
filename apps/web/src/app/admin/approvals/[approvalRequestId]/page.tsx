import { redirect } from "next/navigation";
import { APPROVAL_TARGET_TYPE_CAMPAIGN } from "@mocha-house/contracts";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminApprovalRequest } from "@/lib/internal-auth/admin-approvals";
import { getAdminCampaign } from "@/lib/internal-auth/admin-marketing";
import { getAdminMediaAsset } from "@/lib/internal-auth/admin-media";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { ApprovalDetail } from "@/components/admin/ApprovalDetail";

// Admin → Approvals → detail (Milestone 8J). `approvals.view` gates the
// page; approve/reject inside gate separately on `approvals.decide`. The
// API's own getOne() ALSO requires `marketing.view` for this slice's only
// target type (Campaign) — by the time this page successfully loads the
// request, the viewer is guaranteed to be authorized to see the campaign
// summary fetched below too.
export default async function AdminApprovalDetailPage({
  params,
}: {
  params: Promise<{ approvalRequestId: string }>;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const { approvalRequestId } = await params;
  const caps = session.authorization.capabilities;

  const header = (title: string) => (
    <AdminPageHeader
      title={title}
      breadcrumbs={[
        { label: "Approvals", href: "/admin/approvals" },
        { label: title },
      ]}
    />
  );

  if (!can(caps, "approvals.view")) {
    return (
      <AdminPage>
        {header("Approval request")}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminApprovalRequest(approvalRequestId);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return (
      <AdminPage>
        {header("Approval request")}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (result.outcome === "not-found") {
    return (
      <AdminPage>
        {header("Approval request")}
        <AdminNotFound
          description="This approval request doesn't exist."
          backHref="/admin/approvals"
          backLabel="Back to all approvals"
        />
      </AdminPage>
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        {header("Approval request")}
        <AdminErrorState description="Couldn't load this approval request just now. Please try again." />
      </AdminPage>
    );
  }

  const { approvalRequest } = result.data;

  const campaignResult =
    approvalRequest.targetType === APPROVAL_TARGET_TYPE_CAMPAIGN
      ? await getAdminCampaign(approvalRequest.targetId)
      : null;
  const campaign =
    campaignResult?.outcome === "success" ? campaignResult.data : null;

  // Reuses the same GET /admin/media/:id (Milestone 8I) HeroImagePicker /
  // CampaignImagePicker already call — no new media-resolution logic.
  const mediaResult = campaign?.mediaAssetId
    ? await getAdminMediaAsset(campaign.mediaAssetId)
    : null;
  const mediaAsset = mediaResult?.outcome === "success" ? mediaResult.data.asset : null;

  return (
    <AdminPage>
      {header(approvalRequest.targetLabel)}
      <ApprovalDetail
        approvalRequest={approvalRequest}
        campaign={campaign}
        mediaAsset={mediaAsset}
        canDecide={can(caps, "approvals.decide")}
      />
    </AdminPage>
  );
}
