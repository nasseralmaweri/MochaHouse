import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminCmsPages } from "@/lib/internal-auth/admin-cms";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { CmsPagesList } from "@/components/admin/CmsPagesList";

// Admin → Content (Milestone 8E). Structured content management for a
// small, code-defined set of public page keys — not a page builder.
// `cms.view` is CORPORATE-only and the API enforces it; the check here
// just keeps the page out of the way for anyone who can't use it.
export default async function AdminContentPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="Content"
      description="Manage structured content for select public pages. Layout and design stay in code — this only controls the text."
      breadcrumbs={[{ label: "Content" }]}
    />
  );

  if (!can(session.authorization.capabilities, "cms.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminCmsPages();

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
  if (result.outcome === "error" || result.outcome === "not-found") {
    return (
      <AdminPage>
        {header}
        <AdminErrorState description="Couldn't load content pages just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <CmsPagesList pages={result.data.pages} />
    </AdminPage>
  );
}
