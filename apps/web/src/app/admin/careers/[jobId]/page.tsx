import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import {
  getAdminJobOpening,
  getAdminJobOpeningOptions,
} from "@/lib/internal-auth/admin-careers";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { JobOpeningEditor } from "@/components/admin/JobOpeningEditor";

export default async function AdminJobOpeningPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }
  const { jobId } = await params;
  const caps = session.authorization.capabilities;

  const header = (title: string) => (
    <AdminPageHeader
      title={title}
      breadcrumbs={[
        { label: "Careers", href: "/admin/careers" },
        { label: title },
      ]}
    />
  );

  if (!can(caps, "careers.view")) {
    return (
      <AdminPage>
        {header("Job opening")}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const [jobResult, optionsResult] = await Promise.all([
    getAdminJobOpening(jobId),
    getAdminJobOpeningOptions(),
  ]);

  if (jobResult.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (jobResult.outcome === "forbidden") {
    return (
      <AdminPage>
        {header("Job opening")}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (jobResult.outcome === "not-found") {
    return (
      <AdminPage>
        {header("Job opening")}
        <AdminNotFound
          description="This job opening doesn't exist."
          backHref="/admin/careers"
          backLabel="Back to all job openings"
        />
      </AdminPage>
    );
  }
  if (jobResult.outcome === "error") {
    return (
      <AdminPage>
        {header("Job opening")}
        <AdminErrorState description="Couldn't load this job opening just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header(jobResult.data.title)}
      <JobOpeningEditor
        initial={jobResult.data}
        options={
          optionsResult.outcome === "success" ? optionsResult.data : null
        }
        canManage={can(caps, "careers.manage")}
      />
    </AdminPage>
  );
}
