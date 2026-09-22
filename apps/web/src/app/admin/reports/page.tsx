import Link from "next/link";
import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminForbidden } from "@/components/admin/states";
import { Card } from "@/components/Card";

// Reports home (Milestone 9A, 9B). Both reports are gated on the same
// single `reports.view` permission, so there's no per-card permission
// branching (unlike Administration's four different keys) — this is a
// small selector, not a dashboard: no metrics, no charts, no summary API.
export default async function AdminReportsHomePage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  if (!can(session.authorization.capabilities, "reports.view")) {
    return (
      <AdminPage>
        <AdminPageHeader title="Reports" />
        <AdminForbidden />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="Reports"
        description="HQ visibility into digital ordering performance."
      />
      <ul className="flex flex-col gap-3">
        <li>
          <ReportCard
            href="/admin/reports/orders"
            title="Digital Sales & Orders"
            description="Order volume, digital sales and status breakdown for a date range and optional location."
          />
        </li>
        <li>
          <ReportCard
            href="/admin/reports/locations"
            title="Location Performance"
            description="Compare digital ordering across every location for a date range."
          />
        </li>
        <li>
          <ReportCard
            href="/admin/reports/operations"
            title="Operations Checklist Visibility"
            description="Opening and closing checklist activity recorded across locations for a date range."
          />
        </li>
        <li>
          <ReportCard
            href="/admin/reports/customers"
            title="Customer Growth & Ordering"
            description="Registered customer base size and digital-ordering participation for a date range."
          />
        </li>
      </ul>
    </AdminPage>
  );
}

function ReportCard({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      <Card className="flex items-start justify-between gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-base font-semibold text-text-primary">
            {title}
          </span>
          <span className="text-sm text-text-secondary">{description}</span>
        </span>
        <span aria-hidden="true" className="text-text-muted">
          →
        </span>
      </Card>
    </Link>
  );
}
