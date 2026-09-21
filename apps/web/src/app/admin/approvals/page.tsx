import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminApprovals } from "@/lib/internal-auth/admin-approvals";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { ApprovalsList } from "@/components/admin/ApprovalsList";

// Admin → Approvals (Milestone 8J). A single flat area — no sub-tabs.
// `approvals.view` is CORPORATE-only and the API enforces it (along with
// marketing.view, for this slice's only target type); the check here just
// keeps the page out of the way for anyone who can't use it.
export default async function AdminApprovalsPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const caps = session.authorization.capabilities;
  const header = (
    <AdminPageHeader
      title="Approvals"
      description="Pending, approved and rejected approval requests. Open one to review and decide."
      breadcrumbs={[{ label: "Approvals" }]}
    />
  );

  if (!can(caps, "approvals.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminApprovals({});

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (result.outcome === "error" || result.outcome === "not-found") {
    return (
      <AdminPage>
        {header}
        <AdminErrorState description="Couldn't load approval requests just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <ApprovalsList
        initial={{
          approvalRequests: result.data.approvalRequests,
          nextCursor: result.data.nextCursor,
        }}
      />
    </AdminPage>
  );
}
