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
import { ProductCreateForm } from "@/components/admin/ProductCreateForm";
import { BackLink } from "@/components/BackLink";

// New product (S1). Server component loads the business's categories; the
// form is the client island. `catalog.products.edit` is corporate-only —
// the same check the API enforces on create. `?categoryId=` preselects a
// category (used right after creating one).
export default async function NewProductPage({
  searchParams,
}: {
  searchParams: Promise<{ categoryId?: string | string[] }>;
}) {
  const { categoryId } = await searchParams;

  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="New product"
      breadcrumbs={[
        { label: "Menu & Products", href: "/admin/menu" },
        { label: "Products", href: "/admin/menu/products" },
        { label: "New" },
      ]}
    />
  );

  if (!can(session.authorization.capabilities, "catalog.products.edit")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden
          title="You can't create products"
          description="Editing the catalog is a corporate task. If you think you should have access, ask an administrator."
        />
        <BackLink href="/admin/menu/products">Back to products</BackLink>
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
        <BackLink href="/admin/menu/products">Back to products</BackLink>
      </AdminPage>
    );
  }

  if (result.data.length === 0) {
    return (
      <AdminPage>
        {header}
        <AdminEmptyState
          title="Create a category first"
          description="Every product belongs to a category."
          action={
            <ButtonLink href="/admin/menu/categories/new">
              New category
            </ButtonLink>
          }
        />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <ProductCreateForm
        categories={result.data}
        initialCategoryId={typeof categoryId === "string" ? categoryId : null}
      />
    </AdminPage>
  );
}
