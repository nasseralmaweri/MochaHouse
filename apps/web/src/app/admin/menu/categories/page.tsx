import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminCategories } from "@/lib/internal-auth/admin-catalog";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
} from "@/components/admin/states";
import { ButtonLink } from "@/components/admin/Button";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { Card } from "@/components/Card";

// Admin category list (S1). Server component. `catalog.view` is
// CORPORATE-only and the API enforces it; "New category" shows only to
// someone who can create (`catalog.products.edit`).
export default async function AdminCategoriesPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const capabilities = session.authorization.capabilities;
  const canCreate = can(capabilities, "catalog.products.edit");
  const header = (
    <AdminPageHeader
      title="Categories"
      description="How products are grouped on the menu."
      breadcrumbs={[
        { label: "Menu & Products", href: "/admin/menu" },
        { label: "Categories" },
      ]}
      actions={
        canCreate ? (
          <ButtonLink href="/admin/menu/categories/new">
            New category
          </ButtonLink>
        ) : undefined
      }
    />
  );

  if (!can(capabilities, "catalog.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminCategories();

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden" || result.outcome === "not-found") {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        {header}
        <AdminErrorState description="Couldn't load categories just now. Please try again." />
      </AdminPage>
    );
  }

  if (result.data.length === 0) {
    return (
      <AdminPage>
        {header}
        <AdminEmptyState
          title="No categories yet"
          description="Create a category before adding products."
          action={
            canCreate ? (
              <ButtonLink href="/admin/menu/categories/new">
                New category
              </ButtonLink>
            ) : undefined
          }
        />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <ul className="flex flex-col gap-3">
        {result.data.map((category) => (
          <li key={category.id}>
            <Card className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex flex-col gap-0.5">
                <span className="text-base font-semibold text-text-primary">
                  {category.name}
                </span>
                <span className="text-sm text-text-secondary">
                  {category.productCount === 1
                    ? "1 product"
                    : `${category.productCount} products`}{" "}
                  · {category.slug}
                </span>
              </span>
              <StatusBadge
                label={category.isActive ? "Active" : "Inactive"}
                tone={category.isActive ? "positive" : "neutral"}
              />
            </Card>
          </li>
        ))}
      </ul>
    </AdminPage>
  );
}
