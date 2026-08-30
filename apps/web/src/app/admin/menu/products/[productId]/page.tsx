import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminProduct } from "@/lib/internal-auth/admin-catalog";
import { can } from "@/lib/admin/capabilities";
import { formatPrice } from "@/lib/money";
import { AdminPage, AdminSection } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ButtonLink } from "@/components/admin/Button";
import { BackLink } from "@/components/BackLink";
import { Card } from "@/components/Card";

// Admin product detail (Milestone 5D-3). Server component, read-only. The
// "Edit product" action shows only when the viewer can actually edit; the
// API re-checks on save.
export default async function AdminProductDetailPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  const { productId } = await params;

  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const capabilities = session.authorization.capabilities;
  const breadcrumbs = [
    { label: "Menu & Products", href: "/admin/menu" },
    { label: "Products", href: "/admin/menu/products" },
    { label: "Product" },
  ];

  if (!can(capabilities, "catalog.view")) {
    return (
      <AdminPage>
        <AdminPageHeader title="Product" breadcrumbs={breadcrumbs} />
        <AdminForbidden />
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
        <AdminPageHeader title="Product" breadcrumbs={breadcrumbs} />
        <AdminForbidden />
        <BackLink href="/admin/menu/products">Back to products</BackLink>
      </AdminPage>
    );
  }
  if (result.outcome === "not-found") {
    return (
      <AdminPage>
        <AdminPageHeader title="Product" breadcrumbs={breadcrumbs} />
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
        <AdminPageHeader title="Product" breadcrumbs={breadcrumbs} />
        <AdminErrorState description="Couldn't load this product just now. Please try again." />
        <BackLink href="/admin/menu/products">Back to products</BackLink>
      </AdminPage>
    );
  }

  const product = result.product;
  const canEdit = can(capabilities, "catalog.products.edit");

  return (
    <AdminPage>
      <AdminPageHeader
        title={product.name}
        breadcrumbs={[
          { label: "Menu & Products", href: "/admin/menu" },
          { label: "Products", href: "/admin/menu/products" },
          { label: product.name },
        ]}
        actions={
          canEdit ? (
            <ButtonLink href={`/admin/menu/products/${product.id}/edit`}>
              Edit product
            </ButtonLink>
          ) : undefined
        }
      />

      <div>
        <StatusBadge
          label={product.isActive ? "Active" : "Inactive"}
          tone={product.isActive ? "positive" : "neutral"}
        />
      </div>

      <AdminSection title="Details">
        <Card className="flex flex-col gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
              Standard price
            </span>
            {product.basePrice === null ? (
              <>
                <span className="text-base text-text-primary">
                  No standard price
                </span>
                <span className="text-sm text-text-secondary">
                  A location-specific price is needed anywhere this item should
                  be sold.
                </span>
              </>
            ) : (
              <span className="text-base text-text-primary">
                {formatPrice(product.basePrice, product.currency)}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
              Category
            </span>
            <span className="text-base text-text-primary">
              {product.category.name}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
              Description
            </span>
            <span className="text-sm text-text-secondary">
              {product.description?.trim()
                ? product.description
                : "No description."}
            </span>
          </div>
        </Card>
      </AdminSection>

      <p className="text-xs text-text-muted">Web address: {product.slug}</p>

      <BackLink href="/admin/menu/products">Back to products</BackLink>
    </AdminPage>
  );
}
