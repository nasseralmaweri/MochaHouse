import Link from "next/link";
import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminModifierGroup } from "@/lib/internal-auth/admin-catalog";
import { can } from "@/lib/admin/capabilities";
import { selectionRuleLabel, sharedGroupNotice } from "@/lib/admin/modifiers";
import { AdminPage, AdminSection } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ModifierGroupForm } from "@/components/admin/ModifierGroupForm";
import { ModifierOptionsEditor } from "@/components/admin/ModifierOptionsEditor";
import { BackLink } from "@/components/BackLink";
import { Card } from "@/components/Card";

// One modifier group: its settings, its options and every product that
// uses it. Server component; the editing controls show only with
// `catalog.products.edit` (the API re-checks every change). Because a group
// is shared, the products it changes are listed right at the top.
export default async function AdminModifierGroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<{ created?: string | string[] }>;
}) {
  const { groupId } = await params;
  const justCreated = (await searchParams).created === "1";

  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const capabilities = session.authorization.capabilities;
  const breadcrumbs = [
    { label: "Menu & Products", href: "/admin/menu" },
    { label: "Modifiers", href: "/admin/menu/modifiers" },
    { label: "Modifier group" },
  ];

  if (!can(capabilities, "catalog.view")) {
    return (
      <AdminPage>
        <AdminPageHeader title="Modifier group" breadcrumbs={breadcrumbs} />
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminModifierGroup(groupId);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return (
      <AdminPage>
        <AdminPageHeader title="Modifier group" breadcrumbs={breadcrumbs} />
        <AdminForbidden />
        <BackLink href="/admin/menu/modifiers">Back to modifiers</BackLink>
      </AdminPage>
    );
  }
  if (result.outcome === "not-found") {
    return (
      <AdminPage>
        <AdminPageHeader title="Modifier group" breadcrumbs={breadcrumbs} />
        <AdminNotFound
          title="Modifier group not found"
          description="This group doesn't exist, or it isn't part of this business."
          backHref="/admin/menu/modifiers"
          backLabel="Back to modifiers"
        />
      </AdminPage>
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        <AdminPageHeader title="Modifier group" breadcrumbs={breadcrumbs} />
        <AdminErrorState description="Couldn't load this modifier group just now. Please try again." />
        <BackLink href="/admin/menu/modifiers">Back to modifiers</BackLink>
      </AdminPage>
    );
  }

  const group = result.data;
  const canEdit = can(capabilities, "catalog.products.edit");

  return (
    <AdminPage>
      <AdminPageHeader
        title={group.name}
        description={selectionRuleLabel(group.minSelections, group.maxSelections)}
        breadcrumbs={[
          { label: "Menu & Products", href: "/admin/menu" },
          { label: "Modifiers", href: "/admin/menu/modifiers" },
          { label: group.name },
        ]}
      />

      <div>
        <StatusBadge
          label={group.isActive ? "Active" : "Inactive — not shown to customers"}
          tone={group.isActive ? "positive" : "neutral"}
        />
      </div>

      {justCreated ? (
        <Card
          tone="subtle"
          className="flex flex-col items-start gap-1 text-sm text-text-secondary"
        >
          <p role="status" className="text-base font-medium text-text-primary">
            Modifier group created
          </p>
          <p>
            Add its options below, then add the group to products from each
            product&apos;s page.
          </p>
        </Card>
      ) : null}

      <Card
        tone="subtle"
        className="flex flex-col gap-2 text-sm text-text-secondary"
      >
        <p className="font-medium text-text-primary">
          {sharedGroupNotice(group.products.length)}
        </p>
        {group.products.length > 0 ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {group.products.map((product) => (
              <li key={product.id}>
                <Link
                  href={`/admin/menu/products/${product.id}`}
                  className="underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {product.name}
                </Link>
                {product.isActive ? null : " (inactive)"}
              </li>
            ))}
          </ul>
        ) : (
          <p>Add it to a product from that product&apos;s page.</p>
        )}
      </Card>

      <AdminSection
        title="Options"
        description="Shown to customers in this order. Options are never deleted — deactivate one to stop offering it."
      >
        <ModifierOptionsEditor group={group} canEdit={canEdit} />
      </AdminSection>

      {canEdit ? (
        <AdminSection title="Settings">
          <ModifierGroupForm mode="edit" group={group} />
        </AdminSection>
      ) : null}

      <BackLink href="/admin/menu/modifiers">Back to modifiers</BackLink>
    </AdminPage>
  );
}
