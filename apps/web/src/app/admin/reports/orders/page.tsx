import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminOrdersOverviewReport } from "@/lib/internal-auth/admin-reports";
import { can } from "@/lib/admin/capabilities";
import { normalizeReportFilters } from "@/lib/admin/reports";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { OrdersOverviewReport } from "@/components/admin/OrdersOverviewReport";

// Reports → Digital Sales & Orders (Milestone 9A). Read-only. `reports.view`
// is CORPORATE-only and the API enforces it; the check here just keeps the
// page out of the way for anyone who can't use it. Filters live entirely in
// the URL query string, so the view is refresh-safe and linkable — mirrors
// administration/audit/page.tsx.
export default async function AdminReportsOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{
    startDate?: string | string[];
    endDate?: string | string[];
    locationId?: string | string[];
  }>;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="Digital Sales & Orders"
      description="Digital ordering performance for a date range, optionally filtered to one location."
      breadcrumbs={[
        { label: "Reports", href: "/admin/reports" },
        { label: "Digital Sales & Orders" },
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
  const filters = normalizeReportFilters(params);

  const result = await getAdminOrdersOverviewReport(filters);

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
    // A hand-edited or stale link with a bad filter (e.g. an unknown
    // location, or start after end). Send the viewer back to today's
    // unfiltered default rather than showing an error.
    redirect("/admin/reports/orders");
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
      <OrdersOverviewReport report={result.data} filters={filters} />
    </AdminPage>
  );
}
