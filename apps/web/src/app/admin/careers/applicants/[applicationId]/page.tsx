import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminJobApplication } from "@/lib/internal-auth/admin-applicants";
import { can } from "@/lib/admin/capabilities";
import { applicantName } from "@/lib/admin/applicants";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { ApplicationDetail } from "@/components/admin/ApplicationDetail";

// Admin → Careers → Applicants → detail (Milestone 8C). `applicants.view`
// gates the page; the status control and "add note" form inside gate
// separately on `applicants.manage`. The API re-checks both, and both keys
// are CORPORATE-only.
export default async function AdminApplicantDetailPage({
  params,
}: {
  params: Promise<{ applicationId: string }>;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const { applicationId } = await params;
  const caps = session.authorization.capabilities;

  const header = (title: string) => (
    <AdminPageHeader
      title={title}
      breadcrumbs={[
        { label: "Careers", href: "/admin/careers" },
        { label: "Applicants", href: "/admin/careers/applicants" },
        { label: title },
      ]}
    />
  );

  if (!can(caps, "applicants.view")) {
    return (
      <AdminPage>
        {header("Applicant")}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminJobApplication(applicationId);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return (
      <AdminPage>
        {header("Applicant")}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (result.outcome === "not-found") {
    return (
      <AdminPage>
        {header("Applicant")}
        <AdminNotFound
          description="This application doesn't exist."
          backHref="/admin/careers/applicants"
          backLabel="Back to all applicants"
        />
      </AdminPage>
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        {header("Applicant")}
        <AdminErrorState description="Couldn't load this application just now. Please try again." />
      </AdminPage>
    );
  }

  const title = applicantName(result.data.firstName, result.data.lastName);

  return (
    <AdminPage>
      {header(title)}
      <ApplicationDetail
        detail={result.data}
        canManage={can(caps, "applicants.manage")}
      />
    </AdminPage>
  );
}
