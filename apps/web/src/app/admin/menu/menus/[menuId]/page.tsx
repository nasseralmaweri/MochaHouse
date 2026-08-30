import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminMenu } from "@/lib/internal-auth/admin-catalog";
import { can } from "@/lib/admin/capabilities";
import { formatPrice } from "@/lib/money";
import { AdminPage, AdminSection } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { MenuProductToggle } from "@/components/admin/MenuProductToggle";
import { BackLink } from "@/components/BackLink";
import { Card } from "@/components/Card";

// Admin menu detail (Milestone 5D-4). Server component; each product's
// "Shown on menu" control is a small client island shown only to someone
// who can change menu composition. A globally inactive product is always
// flagged as Inactive, independently of whether it is shown on the menu.
export default async function AdminMenuDetailPage({
  params,
}: {
  params: Promise<{ menuId: string }>;
}) {
  const { menuId } = await params;

  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const capabilities = session.authorization.capabilities;
  const breadcrumbs = [
    { label: "Menu & Products", href: "/admin/menu" },
    { label: "Menus", href: "/admin/menu/menus" },
    { label: "Menu" },
  ];

  if (!can(capabilities, "catalog.view")) {
    return (
      <AdminPage>
        <AdminPageHeader title="Menu" breadcrumbs={breadcrumbs} />
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminMenu(menuId);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return (
      <AdminPage>
        <AdminPageHeader title="Menu" breadcrumbs={breadcrumbs} />
        <AdminForbidden />
        <BackLink href="/admin/menu/menus">Back to menus</BackLink>
      </AdminPage>
    );
  }
  if (result.outcome === "not-found") {
    return (
      <AdminPage>
        <AdminPageHeader title="Menu" breadcrumbs={breadcrumbs} />
        <AdminNotFound
          title="Menu not found"
          description="This menu doesn't exist, or it has been removed."
          backHref="/admin/menu/menus"
          backLabel="Back to menus"
        />
      </AdminPage>
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        <AdminPageHeader title="Menu" breadcrumbs={breadcrumbs} />
        <AdminErrorState description="Couldn't load this menu just now. Please try again." />
        <BackLink href="/admin/menu/menus">Back to menus</BackLink>
      </AdminPage>
    );
  }

  const menu = result.data;
  const canManage = can(capabilities, "catalog.menu.manage");

  return (
    <AdminPage>
      <AdminPageHeader
        title={menu.name}
        breadcrumbs={[
          { label: "Menu & Products", href: "/admin/menu" },
          { label: "Menus", href: "/admin/menu/menus" },
          { label: menu.name },
        ]}
      />

      <div>
        <StatusBadge
          label={menu.isActive ? "Active" : "Inactive"}
          tone={menu.isActive ? "positive" : "neutral"}
        />
      </div>

      <AdminSection title="Products on this menu">
        {menu.products.length === 0 ? (
          <AdminEmptyState
            title="No products on this menu"
            description="This menu has no products yet."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {menu.products.map((item) => (
              <li key={item.productId}>
                <Card className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-semibold text-text-primary">
                        {item.productName}
                      </span>
                      {!item.productIsActive ? (
                        <StatusBadge label="Inactive product" tone="warning" />
                      ) : null}
                    </div>
                    <span className="text-sm text-text-secondary">
                      {item.categoryName} ·{" "}
                      {item.standardPrice === null
                        ? "No standard price"
                        : formatPrice(item.standardPrice, item.currency)}
                    </span>
                  </div>

                  {canManage ? (
                    <MenuProductToggle
                      menuId={menu.id}
                      productId={item.productId}
                      initialShown={item.shownOnMenu}
                    />
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-text-secondary">
                        Shown on menu
                      </span>
                      <StatusBadge
                        label={item.shownOnMenu ? "Yes" : "No"}
                        tone={item.shownOnMenu ? "positive" : "neutral"}
                      />
                    </div>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </AdminSection>

      <BackLink href="/admin/menu/menus">Back to menus</BackLink>
    </AdminPage>
  );
}
