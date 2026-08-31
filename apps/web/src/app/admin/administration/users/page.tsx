import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminUsers } from "@/lib/internal-auth/admin-users";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
} from "@/components/admin/states";
import { UsersBrowser } from "@/components/admin/UsersBrowser";

// Administration → Users (Milestone 5E-1). Read-only. `users.view` is
// CORPORATE-only and the API enforces it; the check here just keeps the
// page out of the way for anyone who can't use it.
export default async function AdminUsersPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="Users"
      description="Everyone who can sign in to the Mocha House Admin."
      breadcrumbs={[
        { label: "Administration", href: "/admin/administration" },
        { label: "Users" },
      ]}
    />
  );

  if (!can(session.authorization.capabilities, "users.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminUsers();

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
        <AdminErrorState description="Couldn't load users just now. Please try again." />
      </AdminPage>
    );
  }

  if (result.data.length === 0) {
    return (
      <AdminPage>
        {header}
        <AdminEmptyState
          title="No users yet"
          description="There are no internal users."
        />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <UsersBrowser users={result.data} />
    </AdminPage>
  );
}
