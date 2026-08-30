import Link from "next/link";
import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminForbidden } from "@/components/admin/states";
import { Card } from "@/components/Card";

// Menu & Products home (Milestone 5D-3). Intentionally lightweight — it is
// the single sidebar destination that will gather products, categories,
// menus and modifiers over the coming slices. Today only Products is a real
// page, so that is the only card here. No "coming soon" links.
export default async function AdminMenuHomePage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  if (!can(session.authorization.capabilities, "catalog.view")) {
    return (
      <AdminPage>
        <AdminPageHeader title="Menu & Products" />
        <AdminForbidden />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="Menu & Products"
        description="Manage the items customers can order."
      />
      <ul className="flex flex-col gap-3">
        <li>
          <Link
            href="/admin/menu/products"
            className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <Card className="flex items-start justify-between gap-3">
              <span className="flex flex-col gap-0.5">
                <span className="text-base font-semibold text-text-primary">
                  Products
                </span>
                <span className="text-sm text-text-secondary">
                  Names, descriptions, prices and whether each item is active.
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
