import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminLocation } from "@/lib/internal-auth/admin-locations";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { LocationEditForm } from "@/components/admin/LocationEditForm";
import { BackLink } from "@/components/BackLink";

// Edit Location (Milestone 5D-2). Server component; the interactive form is
// the client island. `locations.edit` is corporate-only in the permission
// catalog, so this capability is only present for corporate staff — the
// same check the API enforces on PATCH /api/v1/admin/locations/:id. The
// gate here just keeps the edit form out of everyone else's way.
export default async function EditLocationPage({
  params,
}: {
  params: Promise<{ locationId: string }>;
}) {
  const { locationId } = await params;

  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const detailHref = `/admin/locations/${locationId}`;
  const breadcrumbs = [
    { label: "Locations", href: "/admin/locations" },
    { label: "Location", href: detailHref },
    { label: "Edit" },
  ];

  if (!can(session.authorization.capabilities, "locations.edit")) {
    return (
      <AdminPage>
        <AdminPageHeader title="Edit location" breadcrumbs={breadcrumbs} />
        <AdminForbidden
          title="You can't edit locations"
          description="Editing a location is a corporate task. If you think you should have access, ask an administrator."
        />
        <BackLink href={detailHref}>Back to location</BackLink>
      </AdminPage>
    );
  }

  const result = await getAdminLocation(locationId);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return (
      <AdminPage>
        <AdminPageHeader title="Edit location" breadcrumbs={breadcrumbs} />
        <AdminForbidden
          title="Not in your scope"
          description="This location isn't in your assigned scope."
        />
        <BackLink href="/admin/locations">Back to locations</BackLink>
      </AdminPage>
    );
  }
  if (result.outcome === "not-found") {
    return (
      <AdminPage>
        <AdminPageHeader title="Edit location" breadcrumbs={breadcrumbs} />
        <AdminNotFound
          title="Location not found"
          description="This location doesn't exist, or it has been removed."
          backHref="/admin/locations"
          backLabel="Back to locations"
        />
      </AdminPage>
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        <AdminPageHeader title="Edit location" breadcrumbs={breadcrumbs} />
        <AdminErrorState description="Couldn't load this location just now. Please try again." />
        <BackLink href={detailHref}>Back to location</BackLink>
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="Edit location"
        breadcrumbs={[
          { label: "Locations", href: "/admin/locations" },
          { label: result.location.name, href: detailHref },
          { label: "Edit" },
        ]}
      />
      <LocationEditForm location={result.location} />
    </AdminPage>
  );
}
