import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminMediaAssets } from "@/lib/internal-auth/admin-media";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminErrorState, AdminForbidden } from "@/components/admin/states";
import { MediaLibraryGrid } from "@/components/admin/MediaLibraryGrid";

// Admin → Media (Milestone 8F). A simple V1 image library backing CMS
// content. `media.view` is CORPORATE-only and the API enforces it; the
// check here just keeps the page out of the way for anyone who can't use
// it.
export default async function AdminMediaPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="Media"
      description="Images available to CMS pages, such as the Home page hero background."
      breadcrumbs={[{ label: "Media" }]}
    />
  );

  const caps = session.authorization.capabilities;
  if (!can(caps, "media.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminMediaAssets();

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
        <AdminErrorState description="Couldn't load the media library just now. Please try again." />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <MediaLibraryGrid
        initial={result.data.assets}
        canManage={can(caps, "media.manage")}
      />
    </AdminPage>
  );
}
