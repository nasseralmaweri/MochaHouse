import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminSalesTaxReport } from "@/lib/internal-auth/admin-reports";
import { can } from "@/lib/admin/capabilities";
import { normalizeReportFilters } from "@/lib/admin/reports";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { SalesTaxReport } from "@/components/admin/SalesTaxReport";

// V1 Sales Tax PR 3 — Reports → Sales Tax. Read-only. `reports.view` is
// CORPORATE-only and the API enforces it. Filters live in the URL query
// string (refresh-safe and linkable), like the other reports.
export default async function AdminReportsSalesTaxPage({
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
      title="Sales Tax"
      description="Taxable sales, tax collected, tax refunded and net tax for a date range, by location and tax."
      breadcrumbs={[
        { label: "Reports", href: "/admin/reports" },
        { label: "Sales Tax" },
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

  const result = await getAdminSalesTaxReport(filters);

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
    redirect("/admin/reports/sales-tax");
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
      <SalesTaxReport report={result.data} filters={filters} />
    </AdminPage>
  );
}
