import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminOperationsChecklistReport } from "@/lib/internal-auth/admin-reports";
import { can } from "@/lib/admin/capabilities";
import { normalizeDateRangeFilters } from "@/lib/admin/reports";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { OperationsChecklistReport } from "@/components/admin/OperationsChecklistReport";

// Reports → Operations Checklist Visibility (Milestone 9C). Read-only.
// `reports.view` is CORPORATE-only and the API enforces it; the check here
// just keeps the page out of the way for anyone who can't use it. Filters
// live entirely in the URL query string — mirrors reports/locations/page.tsx.
export default async function AdminReportsOperationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    startDate?: string | string[];
    endDate?: string | string[];
  }>;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="Operations Checklist Visibility"
      description="Opening and closing checklist activity recorded across locations for a date range."
      breadcrumbs={[
        { label: "Reports", href: "/admin/reports" },
        { label: "Operations Checklist Visibility" },
      ]}
    />
  );

  if (!can(session.authorization.capabilities, "reports.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const params = await searchParams;
  const filters = normalizeDateRangeFilters(params);

  const result = await getAdminOperationsChecklistReport(filters);

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
  if (result.outcome === "invalid") {
    // A hand-edited or stale link with a bad filter (e.g. start after
    // end). Send the viewer back to today's unfiltered default rather
    // than showing an error.
    redirect("/admin/reports/operations");
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        {header}
        <AdminErrorState description="Couldn't load this report just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <OperationsChecklistReport report={result.data} filters={filters} />
    </AdminPage>
  );
}
