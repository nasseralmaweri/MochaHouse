import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminRole } from "@/lib/internal-auth/admin-roles";
import { can } from "@/lib/admin/capabilities";
import { peopleCountLabel } from "@/lib/admin/user-access";
import { AdminPage, AdminSection } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { BackLink } from "@/components/BackLink";
import { Card } from "@/components/Card";

// Administration → Access Levels → detail (Milestone 5E-2). Read-only. The
// "What this access level allows" list is produced by the API from the
// role's stored known permissions (scope-agnostic wording), never the role
// name. No editing controls in this slice.
export default async function AdminAccessLevelDetailPage({
  params,
}: {
  params: Promise<{ internalRoleId: string }>;
}) {
  const { internalRoleId } = await params;

  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const breadcrumbs = [
    { label: "Administration", href: "/admin/administration" },
    { label: "Access levels", href: "/admin/administration/roles" },
    { label: "Access level" },
  ];

  if (!can(session.authorization.capabilities, "roles.view")) {
    return (
      <AdminPage>
        <AdminPageHeader title="Access level" breadcrumbs={breadcrumbs} />
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminRole(internalRoleId);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return (
      <AdminPage>
        <AdminPageHeader title="Access level" breadcrumbs={breadcrumbs} />
        <AdminForbidden />
        <BackLink href="/admin/administration/roles">
          Back to access levels
        </BackLink>
      </AdminPage>
    );
  }
  if (result.outcome === "not-found") {
    return (
      <AdminPage>
        <AdminPageHeader title="Access level" breadcrumbs={breadcrumbs} />
        <AdminNotFound
          title="Access level not found"
          description="This access level doesn't exist, or it has been removed."
          backHref="/admin/administration/roles"
          backLabel="Back to access levels"
        />
      </AdminPage>
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        <AdminPageHeader title="Access level" breadcrumbs={breadcrumbs} />
        <AdminErrorState description="Couldn't load this access level just now. Please try again." />
        <BackLink href="/admin/administration/roles">
          Back to access levels
        </BackLink>
      </AdminPage>
    );
  }

  const role = result.data;

  return (
    <AdminPage>
      <AdminPageHeader
        title={role.displayName}
        breadcrumbs={[
          { label: "Administration", href: "/admin/administration" },
          { label: "Access levels", href: "/admin/administration/roles" },
          { label: role.displayName },
        ]}
      />

      {role.isBuiltIn ? (
        <div>
          <StatusBadge label="Built-in" tone="neutral" />
        </div>
      ) : null}

      <AdminSection title="About">
        <Card className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">
            {role.description ?? "No description."}
          </p>
          <p className="text-sm text-text-primary">
            {peopleCountLabel(role.userCount)} ha
            {role.userCount === 1 ? "s" : "ve"} this access level.
          </p>
        </Card>
      </AdminSection>

      <AdminSection title="What this access level allows">
        {role.capabilities.length === 0 ? (
          <AdminEmptyState
            title="Nothing yet"
            description="This access level doesn't include any Admin capabilities."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {role.capabilities.map((group) => (
              <Card key={group.group} className="flex flex-col gap-2">
                <span className="text-sm font-semibold text-text-primary">
                  {group.group}
                </span>
                <ul className="flex flex-col gap-1">
                  {group.items.map((item) => (
                    <li key={item} className="text-sm text-text-secondary">
                      {item}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        )}
      </AdminSection>

      <BackLink href="/admin/administration/roles">
        Back to access levels
      </BackLink>
    </AdminPage>
  );
}
