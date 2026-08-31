import Link from "next/link";
import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminForbidden } from "@/components/admin/states";
import { Card } from "@/components/Card";

// Administration home (Milestone 5E, 5F). Real capability cards only —
// Users (5E-1), Access Levels (5E-2), Activity log (5F) — each shown only
// for the permission that backs it. No "coming soon" cards for
// Configuration / Integration.
export default async function AdministrationHomePage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const capabilities = session.authorization.capabilities;
  const canViewUsers = can(capabilities, "users.view");
  const canViewRoles = can(capabilities, "roles.view");
  const canViewAudit = can(capabilities, "audit.view");

  if (!canViewUsers && !canViewRoles && !canViewAudit) {
    return (
      <AdminPage>
        <AdminPageHeader title="Administration" />
        <AdminForbidden />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="Administration"
        description="Manage who works in the Mocha House Admin."
      />
      <ul className="flex flex-col gap-3">
        {canViewUsers ? (
          <li>
            <AdministrationCard
              href="/admin/administration/users"
              title="Users"
              description="See who can access the Mocha House Admin and what they can do."
            />
          </li>
        ) : null}
        {canViewRoles ? (
          <li>
            <AdministrationCard
              href="/admin/administration/roles"
              title="Access levels"
              description="See the types of Admin access and what each one allows."
            />
          </li>
        ) : null}
        {canViewAudit ? (
          <li>
            <AdministrationCard
              href="/admin/administration/audit"
              title="Activity log"
              description="Review important changes to Admin access and permissions."
            />
          </li>
        ) : null}
      </ul>
    </AdminPage>
  );
}

function AdministrationCard({
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
