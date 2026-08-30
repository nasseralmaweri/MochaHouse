import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminProducts } from "@/lib/internal-auth/admin-catalog";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
} from "@/components/admin/states";
import { ProductsBrowser } from "@/components/admin/ProductsBrowser";

// Admin product list (Milestone 5D-3). Server component fetches the
// authorized, scope-checked list; the small client island handles the
// search box and filtering. `catalog.view` is CORPORATE-only and the API
// enforces it — the check here just keeps the page out of the way for
// anyone who can't use it.
export default async function AdminProductsPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="Products"
      description="Every item in the Mocha House catalog."
      breadcrumbs={[
        { label: "Menu & Products", href: "/admin/menu" },
        { label: "Products" },
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

  const result = await getAdminProducts();

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
  if (result.outcome === "error") {
    return (
      <AdminPage>
        {header}
        <AdminErrorState description="Couldn't load products just now. Please try again." />
      </AdminPage>
    );
  }

  if (result.products.length === 0) {
    return (
      <AdminPage>
        {header}
        <AdminEmptyState
          title="No products yet"
          description="The catalog is empty."
        />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <ProductsBrowser products={result.products} />
    </AdminPage>
  );
}
