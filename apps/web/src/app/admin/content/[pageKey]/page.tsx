import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminCmsPage } from "@/lib/internal-auth/admin-cms";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { FranchisingContentEditor } from "@/components/admin/FranchisingContentEditor";

// Admin → Content → detail (Milestone 8E). `cms.view` gates the page; the
// Save draft / Publish controls inside gate separately on `cms.manage`.
// The API re-checks both, and both keys are CORPORATE-only. 8E manages
// exactly one page key ("franchising"); any other key is a 404 from the
// API's code-defined registry.
export default async function AdminContentPageDetail({
  params,
}: {
  params: Promise<{ pageKey: string }>;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const { pageKey } = await params;
  const caps = session.authorization.capabilities;

  const header = (title: string) => (
    <AdminPageHeader
      title={title}
      breadcrumbs={[
        { label: "Content", href: "/admin/content" },
        { label: title },
      ]}
    />
  );

  if (!can(caps, "cms.view")) {
    return (
      <AdminPage>
        {header("Content")}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminCmsPage(pageKey);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return (
      <AdminPage>
        {header("Content")}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (result.outcome === "not-found") {
    return (
      <AdminPage>
        {header("Content")}
        <AdminNotFound
          description="This content page doesn't exist."
          backHref="/admin/content"
          backLabel="Back to all content"
        />
      </AdminPage>
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        {header("Content")}
        <AdminErrorState description="Couldn't load this content page just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header(result.data.title)}
      <FranchisingContentEditor
        pageKey={pageKey}
        initial={result.data}
        canManage={can(caps, "cms.manage")}
      />
    </AdminPage>
  );
}
