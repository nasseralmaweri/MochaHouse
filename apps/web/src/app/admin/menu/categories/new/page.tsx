import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminForbidden } from "@/components/admin/states";
import { CategoryCreateForm } from "@/components/admin/CategoryCreateForm";
import { BackLink } from "@/components/BackLink";

// New category (S1). `catalog.products.edit` is corporate-only — the same
// check the API enforces on create.
export default async function NewCategoryPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="New category"
      breadcrumbs={[
        { label: "Menu & Products", href: "/admin/menu" },
        { label: "Categories", href: "/admin/menu/categories" },
        { label: "New" },
      ]}
    />
  );

  if (!can(session.authorization.capabilities, "catalog.products.edit")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden
          title="You can't create categories"
          description="Editing the catalog is a corporate task. If you think you should have access, ask an administrator."
        />
        <BackLink href="/admin/menu/categories">Back to categories</BackLink>
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <CategoryCreateForm />
    </AdminPage>
  );
}
