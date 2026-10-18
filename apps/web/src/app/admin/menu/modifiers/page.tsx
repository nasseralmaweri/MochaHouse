import Link from "next/link";
import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminModifierGroups } from "@/lib/internal-auth/admin-catalog";
import { can } from "@/lib/admin/capabilities";
import { selectionRuleLabel } from "@/lib/admin/modifiers";
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

// Admin > Menu > Modifiers (Product Modifier Management). Server component.
// `catalog.view` is CORPORATE-only and the API enforces it; "New modifier
// group" shows only to someone who can edit (`catalog.products.edit`).
export default async function AdminModifiersPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const capabilities = session.authorization.capabilities;
  const canCreate = can(capabilities, "catalog.products.edit");
  const header = (
    <AdminPageHeader
      title="Modifiers"
      description="Choices customers make on a product, like size or milk. One group can be used by many products."
      breadcrumbs={[
        { label: "Menu & Products", href: "/admin/menu" },
        { label: "Modifiers" },
      ]}
      actions={
        canCreate ? (
          <ButtonLink href="/admin/menu/modifiers/new">
            New modifier group
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

  const result = await getAdminModifierGroups();

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
        <AdminErrorState description="Couldn't load modifier groups just now. Please try again." />
      </AdminPage>
    );
  }

  if (result.data.length === 0) {
    return (
      <AdminPage>
        {header}
        <AdminEmptyState
          title="No modifier groups yet"
          description='Create a group such as "Size", add its options, then add it to products from each product page.'
          action={
            canCreate ? (
              <ButtonLink href="/admin/menu/modifiers/new">
                New modifier group
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
        {result.data.map((group) => (
          <li key={group.id}>
            <Link
              href={`/admin/menu/modifiers/${group.id}`}
              className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <Card className="flex flex-wrap items-center justify-between gap-3">
                <span className="flex flex-col gap-0.5">
                  <span className="text-base font-semibold text-text-primary">
                    {group.name}
                  </span>
                  <span className="text-sm text-text-secondary">
                    {selectionRuleLabel(group.minSelections, group.maxSelections)}
                  </span>
                  <span className="text-sm text-text-secondary">
                    {group.activeOptionCount} of {group.optionCount} option
                    {group.optionCount === 1 ? "" : "s"} active ·{" "}
                    {group.productCount === 0
                      ? "not on any product"
                      : group.productCount === 1
                        ? "used by 1 product"
                        : `used by ${group.productCount} products`}
                  </span>
                </span>
                <StatusBadge
                  label={group.isActive ? "Active" : "Inactive"}
                  tone={group.isActive ? "positive" : "neutral"}
                />
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </AdminPage>
  );
}
