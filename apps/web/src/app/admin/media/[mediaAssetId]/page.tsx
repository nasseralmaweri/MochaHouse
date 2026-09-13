import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminMediaAsset } from "@/lib/internal-auth/admin-media";
import { can } from "@/lib/admin/capabilities";
import { mediaAssetDisplayTitle } from "@/lib/admin/media";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { MediaAssetDetail } from "@/components/admin/MediaAssetDetail";

// Admin → Media → detail (Milestone 8I). `media.view` gates the page;
// editing title/alt text and archiving gate separately on `media.manage`
// inside MediaAssetDetail. The API re-checks both. Unlike the library grid
// (GET /admin/media, active assets only), this reads GET /admin/media/:id
// directly so an already-archived asset can still be viewed here.
export default async function AdminMediaAssetDetailPage({
  params,
}: {
  params: Promise<{ mediaAssetId: string }>;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const { mediaAssetId } = await params;

  const header = (title: string) => (
    <AdminPageHeader
      title={title}
      breadcrumbs={[
        { label: "Media", href: "/admin/media" },
        { label: title },
      ]}
    />
  );

  const caps = session.authorization.capabilities;
  if (!can(caps, "media.view")) {
    return (
      <AdminPage>
        {header("Media")}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminMediaAsset(mediaAssetId);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return (
      <AdminPage>
        {header("Media")}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (result.outcome === "not-found") {
    return (
      <AdminPage>
        {header("Media")}
        <AdminNotFound
          description="This image doesn't exist."
          backHref="/admin/media"
          backLabel="Back to the media library"
        />
      </AdminPage>
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        {header("Media")}
        <AdminErrorState description="Couldn't load this image just now. Please try again." />
      </AdminPage>
    );
  }

  const { asset } = result.data;

  return (
    <AdminPage>
      {header(mediaAssetDisplayTitle(asset))}
      <MediaAssetDetail asset={asset} canManage={can(caps, "media.manage")} />
    </AdminPage>
  );
}
