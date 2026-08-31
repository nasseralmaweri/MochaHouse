import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminUser } from "@/lib/internal-auth/admin-users";
import { can } from "@/lib/admin/capabilities";
import {
  accessLevelsLabel,
  locationAccessLabel,
  userStatusLabel,
  userStatusTone,
} from "@/lib/admin/user-access";
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

// Administration → Users → detail (Milestone 5E-1). Read-only. The
// "What they can do" list is produced by the API from effective
// authorization (permission + scope), never a role name. No mutation
// controls in this slice.
export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ internalUserId: string }>;
}) {
  const { internalUserId } = await params;

  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const breadcrumbs = [
    { label: "Administration", href: "/admin/administration" },
    { label: "Users", href: "/admin/administration/users" },
    { label: "User" },
  ];

  if (!can(session.authorization.capabilities, "users.view")) {
    return (
      <AdminPage>
        <AdminPageHeader title="User" breadcrumbs={breadcrumbs} />
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminUser(internalUserId);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return (
      <AdminPage>
        <AdminPageHeader title="User" breadcrumbs={breadcrumbs} />
        <AdminForbidden />
        <BackLink href="/admin/administration/users">Back to users</BackLink>
      </AdminPage>
    );
  }
  if (result.outcome === "not-found") {
    return (
      <AdminPage>
        <AdminPageHeader title="User" breadcrumbs={breadcrumbs} />
        <AdminNotFound
          title="User not found"
          description="This user doesn't exist, or the record has been removed."
          backHref="/admin/administration/users"
          backLabel="Back to users"
        />
      </AdminPage>
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        <AdminPageHeader title="User" breadcrumbs={breadcrumbs} />
        <AdminErrorState description="Couldn't load this user just now. Please try again." />
        <BackLink href="/admin/administration/users">Back to users</BackLink>
      </AdminPage>
    );
  }

  const user = result.data;
  const name = user.displayName ?? user.email;

  return (
    <AdminPage>
      <AdminPageHeader
        title={name}
        breadcrumbs={[
          { label: "Administration", href: "/admin/administration" },
          { label: "Users", href: "/admin/administration/users" },
          { label: name },
        ]}
      />

      <div>
        <StatusBadge
          label={userStatusLabel(user.status)}
          tone={userStatusTone(user.status)}
        />
      </div>

      <AdminSection title="Account">
        <Card className="flex flex-col gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
              Email
            </span>
            <span className="text-base text-text-primary">{user.email}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
              Access level
            </span>
            <span className="text-base text-text-primary">
              {accessLevelsLabel(user.accessLevels)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
              Locations
            </span>
            <span className="text-base text-text-primary">
              {locationAccessLabel(user.locationAccess)}
            </span>
          </div>
        </Card>
      </AdminSection>

      <AdminSection title="What they can do">
        {user.capabilities.length === 0 ? (
          <AdminEmptyState
            title="No access yet"
            description="This person has no access level assigned, so they can't do anything in the Admin."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {user.capabilities.map((group) => (
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

      <BackLink href="/admin/administration/users">Back to users</BackLink>
    </AdminPage>
  );
}
