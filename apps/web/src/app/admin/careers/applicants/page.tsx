import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminJobApplications } from "@/lib/internal-auth/admin-applicants";
import { getAdminJobOpenings } from "@/lib/internal-auth/admin-careers";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { CareersTabs } from "@/components/admin/CareersTabs";
import { ApplicantsBrowser } from "@/components/admin/ApplicantsBrowser";

// Admin → Careers → Applicants (Milestone 8C). `applicants.view` is
// CORPORATE-only and the API enforces it; the check here just keeps the page
// out of the way for anyone who can't use it. Candidate PII never reaches a
// location-scoped role.
export default async function AdminApplicantsPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const caps = session.authorization.capabilities;
  const tabs = (
    <CareersTabs
      active="applicants"
      canViewJobs={can(caps, "careers.view")}
      canViewApplicants={can(caps, "applicants.view")}
    />
  );
  const header = (
    <AdminPageHeader
      title="Applicants"
      description="People who have applied to a job opening. Open an applicant to see their answers, change their status, and add internal notes."
      breadcrumbs={[
        { label: "Careers", href: "/admin/careers" },
        { label: "Applicants" },
      ]}
    />
  );

  if (!can(caps, "applicants.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const [result, jobsResult] = await Promise.all([
    getAdminJobApplications({}),
    getAdminJobOpenings(),
  ]);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return (
      <AdminPage>
        {header}
        {tabs}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (result.outcome === "error" || result.outcome === "not-found") {
    return (
      <AdminPage>
        {header}
        {tabs}
        <AdminErrorState description="Couldn't load applicants just now. Please try again." />
      </AdminPage>
    );
  }

  const jobOptions =
    jobsResult.outcome === "success"
      ? jobsResult.data.jobs.map((job) => ({ id: job.id, title: job.title }))
      : [];

  return (
    <AdminPage>
      {header}
      {tabs}
      <ApplicantsBrowser
        initial={{
          applications: result.data.applications,
          nextCursor: result.data.nextCursor,
        }}
        jobOptions={jobOptions}
      />
    </AdminPage>
  );
}
