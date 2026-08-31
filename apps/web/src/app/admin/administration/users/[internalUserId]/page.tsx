import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import {
  getAdminAccessOptions,
  getAdminUser,
} from "@/lib/internal-auth/admin-users";
import { can } from "@/lib/admin/capabilities";
import {
  accessLevelsLabel,
  assignmentWhereLabel,
  canManageAccess,
  canShowStatusActions,
  locationAccessLabel,
  userStatusLabel,
  userStatusSentence,
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
import { UserStatusControl } from "@/components/admin/UserStatusControl";
import { UserAccessControl } from "@/components/admin/UserAccessControl";
import { BackLink } from "@/components/BackLink";
import { Card } from "@/components/Card";

// Administration → Users → detail. The "What they can do" list is produced
// by the API from effective authorization (permission + scope), never a
// role name. Milestone 5E-3 adds the status control (Suspend / Reactivate /
// Disable), shown only when the viewer holds `users.manage_status` and is
// not looking at their own record; the API is the authority for every rule.
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
  const isSelf = user.id === session.user.id;
  const showStatusActions = canShowStatusActions({
    hasManageStatusPermission: can(
      session.authorization.capabilities,
      "users.manage_status",
    ),
    isSelf,
    status: user.status,
  });

  const showManageAccess = canManageAccess({
    hasManageRolesPermission: can(
      session.authorization.capabilities,
      "users.manage_roles",
    ),
    isSelf,
  });
  // Only fetched when the controls will actually render — the endpoint is
  // gated by `users.manage_roles`.
  const accessOptionsResult = showManageAccess
    ? await getAdminAccessOptions()
    : null;
  const accessOptions =
    accessOptionsResult?.outcome === "success"
      ? accessOptionsResult.data
      : null;

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

      <AdminSection title="Status">
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              label={userStatusLabel(user.status)}
              tone={userStatusTone(user.status)}
            />
            <span className="text-sm text-text-secondary">
              {userStatusSentence(user.status)}
            </span>
          </div>
          {showStatusActions ? (
            <UserStatusControl
              internalUserId={user.id}
              status={user.status}
            />
          ) : null}
        </Card>
      </AdminSection>

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

      <AdminSection title="Access">
        <Card className="flex flex-col gap-4">
          {showManageAccess && accessOptions ? (
            <UserAccessControl
              internalUserId={user.id}
              assignments={user.assignments}
              options={accessOptions}
            />
          ) : user.assignments.length === 0 ? (
            <span className="text-sm text-text-secondary">
              This person has no access assigned yet.
            </span>
          ) : (
            <ul className="flex flex-col gap-1">
              {user.assignments.map((assignment) => (
                <li key={assignment.id} className="text-sm text-text-primary">
                  <span className="font-medium">
                    {assignment.accessLevel.displayName}
                  </span>{" "}
                  · {assignmentWhereLabel(assignment)}
                </li>
              ))}
            </ul>
          )}
          {showManageAccess && !accessOptions ? (
            <span className="text-sm text-text-secondary">
              The tools for changing access aren’t available right now.
            </span>
          ) : null}
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
