import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminProduct } from "@/lib/internal-auth/admin-catalog";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { ProductEditForm } from "@/components/admin/ProductEditForm";
import { BackLink } from "@/components/BackLink";

// Edit product (Milestone 5D-3). Server component; the form is the client
// island. `catalog.products.edit` is corporate-only in the permission
// catalog, so this capability is only present for corporate staff — the
// same check the API enforces on PATCH.
export default async function EditProductPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  const { productId } = await params;

  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const detailHref = `/admin/menu/products/${productId}`;
  const breadcrumbs = [
    { label: "Menu & Products", href: "/admin/menu" },
    { label: "Products", href: "/admin/menu/products" },
    { label: "Product", href: detailHref },
    { label: "Edit" },
  ];

  if (!can(session.authorization.capabilities, "catalog.products.edit")) {
    return (
      <AdminPage>
        <AdminPageHeader title="Edit product" breadcrumbs={breadcrumbs} />
        <AdminForbidden
          title="You can't edit products"
          description="Editing the catalog is a corporate task. If you think you should have access, ask an administrator."
        />
        <BackLink href={detailHref}>Back to product</BackLink>
      </AdminPage>
    );
  }

  const result = await getAdminProduct(productId);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return (
      <AdminPage>
        <AdminPageHeader title="Edit product" breadcrumbs={breadcrumbs} />
        <AdminForbidden />
        <BackLink href="/admin/menu/products">Back to products</BackLink>
      </AdminPage>
    );
  }
  if (result.outcome === "not-found") {
    return (
      <AdminPage>
        <AdminPageHeader title="Edit product" breadcrumbs={breadcrumbs} />
        <AdminNotFound
          title="Product not found"
          description="This product doesn't exist, or it has been removed."
          backHref="/admin/menu/products"
          backLabel="Back to products"
        />
      </AdminPage>
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        <AdminPageHeader title="Edit product" breadcrumbs={breadcrumbs} />
        <AdminErrorState description="Couldn't load this product just now. Please try again." />
        <BackLink href={detailHref}>Back to product</BackLink>
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="Edit product"
        breadcrumbs={[
          { label: "Menu & Products", href: "/admin/menu" },
          { label: "Products", href: "/admin/menu/products" },
          { label: result.product.name, href: detailHref },
          { label: "Edit" },
        ]}
      />
      <ProductEditForm product={result.product} />
    </AdminPage>
  );
}
