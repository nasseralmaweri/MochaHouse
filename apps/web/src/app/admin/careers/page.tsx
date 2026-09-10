import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import {
  getAdminJobOpeningOptions,
  getAdminJobOpenings,
} from "@/lib/internal-auth/admin-careers";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { CareersManager } from "@/components/admin/CareersManager";
import { CareersTabs } from "@/components/admin/CareersTabs";

// Admin → Careers (Milestone 8B). Manage job openings — draft, publish,
// unpublish, archive. `careers.view` gates the page; create/edit/actions
// gate on `careers.manage`. The API enforces both.
export default async function AdminCareersPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const caps = session.authorization.capabilities;
  const tabs = (
    <CareersTabs
      active="jobs"
      canViewJobs={can(caps, "careers.view")}
      canViewApplicants={can(caps, "applicants.view")}
    />
  );
  const header = (
    <AdminPageHeader
      title="Careers"
      description="Job openings shown on the public Careers page. Only published openings are visible to the public."
      breadcrumbs={[{ label: "Careers" }]}
    />
  );

  if (!can(caps, "careers.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const [jobsResult, optionsResult] = await Promise.all([
    getAdminJobOpenings(),
    getAdminJobOpeningOptions(),
  ]);

  if (jobsResult.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (jobsResult.outcome === "forbidden") {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (jobsResult.outcome === "error" || jobsResult.outcome === "not-found") {
    return (
      <AdminPage>
        {header}
        <AdminErrorState description="Couldn't load job openings just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      {tabs}
      <CareersManager
        jobs={jobsResult.data.jobs}
        options={
          optionsResult.outcome === "success" ? optionsResult.data : null
        }
        canManage={can(caps, "careers.manage")}
      />
    </AdminPage>
  );
}
