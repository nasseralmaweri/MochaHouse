import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminCustomerGrowthReport } from "@/lib/internal-auth/admin-reports";
import { can } from "@/lib/admin/capabilities";
import { normalizeDateRangeFilters } from "@/lib/admin/reports";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { CustomerGrowthReport } from "@/components/admin/CustomerGrowthReport";

// Reports → Customer Growth & Ordering (Milestone 9D). Read-only.
// `reports.view` is CORPORATE-only and the API enforces it; the check here
// just keeps the page out of the way for anyone who can't use it. Filters
// live entirely in the URL query string — mirrors reports/operations/page.tsx.
export default async function AdminReportsCustomersPage({
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
      title="Customer Growth & Ordering"
      description="Registered customer base size and digital-ordering participation for a date range."
      breadcrumbs={[
        { label: "Reports", href: "/admin/reports" },
        { label: "Customer Growth & Ordering" },
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

  const result = await getAdminCustomerGrowthReport(filters);

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
    redirect("/admin/reports/customers");
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
      <CustomerGrowthReport report={result.data} filters={filters} />
    </AdminPage>
  );
}
