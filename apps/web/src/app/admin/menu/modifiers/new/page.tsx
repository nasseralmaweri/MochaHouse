import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminForbidden } from "@/components/admin/states";
import { ModifierGroupForm } from "@/components/admin/ModifierGroupForm";
import { BackLink } from "@/components/BackLink";

// New modifier group. `catalog.products.edit` is corporate-only — the same
// check the API enforces on create. Options are added on the next page.
export default async function NewModifierGroupPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="New modifier group"
      description="Set the name and how many choices customers make. You'll add the options next."
      breadcrumbs={[
        { label: "Menu & Products", href: "/admin/menu" },
        { label: "Modifiers", href: "/admin/menu/modifiers" },
        { label: "New" },
      ]}
    />
  );

  if (!can(session.authorization.capabilities, "catalog.products.edit")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden
          title="You can't create modifier groups"
          description="Editing the catalog is a corporate task. If you think you should have access, ask an administrator."
        />
        <BackLink href="/admin/menu/modifiers">Back to modifiers</BackLink>
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <ModifierGroupForm mode="create" />
    </AdminPage>
  );
}
