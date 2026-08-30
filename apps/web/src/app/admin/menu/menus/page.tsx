import Link from "next/link";
import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminMenus } from "@/lib/internal-auth/admin-catalog";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
} from "@/components/admin/states";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { Card } from "@/components/Card";

// Admin menu list (Milestone 5D-4). Server component. `catalog.view` is
// CORPORATE-only and the API enforces it.
export default async function AdminMenusPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="Menus"
      description="Which products appear on each menu."
      breadcrumbs={[
        { label: "Menu & Products", href: "/admin/menu" },
        { label: "Menus" },
      ]}
    />
  );

  if (!can(session.authorization.capabilities, "catalog.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminMenus();

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
        <AdminErrorState description="Couldn't load menus just now. Please try again." />
      </AdminPage>
    );
  }

  if (result.data.length === 0) {
    return (
      <AdminPage>
        {header}
        <AdminEmptyState title="No menus yet" description="There are no menus." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <ul className="flex flex-col gap-2">
        {result.data.map((menu) => (
          <li key={menu.id}>
            <Link
              href={`/admin/menu/menus/${menu.id}`}
              className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <Card className="flex items-center justify-between gap-3">
                <span className="text-base font-semibold text-text-primary">
                  {menu.name}
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge
                    label={menu.isActive ? "Active" : "Inactive"}
                    tone={menu.isActive ? "positive" : "neutral"}
                  />
                  <span aria-hidden="true" className="text-text-muted">
                    →
                  </span>
                </span>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </AdminPage>
  );
}
