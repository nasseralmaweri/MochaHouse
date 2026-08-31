import Link from "next/link";
import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminForbidden } from "@/components/admin/states";
import { Card } from "@/components/Card";

// Administration home (Milestone 5E-1). One real card — Users — because
// that is the only Administration capability that exists yet. No "coming
// soon" cards for Roles / Audit / Configuration.
export default async function AdministrationHomePage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  if (!can(session.authorization.capabilities, "users.view")) {
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
        <li>
          <Link
            href="/admin/administration/users"
            className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <Card className="flex items-start justify-between gap-3">
              <span className="flex flex-col gap-0.5">
                <span className="text-base font-semibold text-text-primary">
                  Users
                </span>
                <span className="text-sm text-text-secondary">
                  See who can access the Mocha House Admin and what they can do.
                </span>
              </span>
              <span aria-hidden="true" className="text-text-muted">
                →
              </span>
            </Card>
          </Link>
        </li>
      </ul>
    </AdminPage>
  );
}
