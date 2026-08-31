import Link from "next/link";
import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminRoles } from "@/lib/internal-auth/admin-roles";
import { can } from "@/lib/admin/capabilities";
import { peopleCountLabel } from "@/lib/admin/user-access";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
} from "@/components/admin/states";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { Card } from "@/components/Card";

// Administration → Access Levels (Milestone 5E-2). Read-only. `roles.view`
// is CORPORATE-only and the API enforces it.
export default async function AdminAccessLevelsPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="Access levels"
      description="Access levels define what people can do in the Mocha House Admin."
      breadcrumbs={[
        { label: "Administration", href: "/admin/administration" },
        { label: "Access levels" },
      ]}
    />
  );

  if (!can(session.authorization.capabilities, "roles.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminRoles();

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
  if (result.outcome === "error" || result.outcome === "not-found") {
    return (
      <AdminPage>
        {header}
        <AdminErrorState description="Couldn't load access levels just now. Please try again." />
      </AdminPage>
    );
  }

  if (result.data.length === 0) {
    return (
      <AdminPage>
        {header}
        <AdminEmptyState
          title="No access levels yet"
          description="There are no access levels."
        />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <ul className="flex flex-col gap-2">
        {result.data.map((role) => (
          <li key={role.id}>
            <Link
              href={`/admin/administration/roles/${role.id}`}
              className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <Card className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-3">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold text-text-primary">
                      {role.displayName}
                    </span>
                    {role.isBuiltIn ? (
                      <StatusBadge label="Built-in" tone="neutral" />
                    ) : null}
                  </span>
                  <span aria-hidden="true" className="text-text-muted">
                    →
                  </span>
                </div>
                {role.description ? (
                  <span className="text-sm text-text-secondary">
                    {role.description}
                  </span>
                ) : null}
                <span className="text-sm text-text-muted">
                  {peopleCountLabel(role.userCount)}
                </span>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </AdminPage>
  );
}
