import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminLocation } from "@/lib/internal-auth/admin-locations";
import { can } from "@/lib/admin/capabilities";
import { AdminPage, AdminSection } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { BackLink } from "@/components/BackLink";
import { Card } from "@/components/Card";

// Admin Location detail (Milestone 5D-1). Server component, read-only.
// Authorization is the API's: `getAdminLocation` hits the guarded
// `/api/v1/admin/locations/:id` route, which calls
// `assertCanActOnLocation('locations.view', :id)` before the row is read —
// a location outside the caller's scope is a 403 here, surfaced as
// AdminForbidden (never a silent redirect to a different location).
//
// No editing controls and no digital-ordering toggle — those are 5D-2.
export default async function AdminLocationDetailPage({
  params,
}: {
  params: Promise<{ locationId: string }>;
}) {
  const { locationId } = await params;

  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const breadcrumbs = [
    { label: "Locations", href: "/admin/locations" },
    { label: "Location" },
  ];

  if (!can(session.authorization.capabilities, "locations.view")) {
    return (
      <AdminPage>
        <AdminPageHeader title="Location" breadcrumbs={breadcrumbs} />
        <AdminForbidden />
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
        <AdminPageHeader title="Location" breadcrumbs={breadcrumbs} />
        <AdminForbidden
          title="Not in your scope"
          description="This location isn't in your assigned scope. Pick one from the Locations list."
        />
        <BackLink href="/admin/locations">Back to locations</BackLink>
      </AdminPage>
    );
  }
  if (result.outcome === "not-found") {
    return (
      <AdminPage>
        <AdminPageHeader title="Location" breadcrumbs={breadcrumbs} />
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
        <AdminPageHeader title="Location" breadcrumbs={breadcrumbs} />
        <AdminErrorState description="Couldn't load this location just now. Please try again." />
        <BackLink href="/admin/locations">Back to locations</BackLink>
      </AdminPage>
    );
  }

  const location = result.location;

  return (
    <AdminPage>
      <AdminPageHeader
        title={location.name}
        breadcrumbs={[
          { label: "Locations", href: "/admin/locations" },
          { label: location.name },
        ]}
      />

      <AdminSection title="Status">
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              label={location.isActive ? "Active" : "Inactive"}
              tone={location.isActive ? "positive" : "neutral"}
            />
            <StatusBadge
              label={
                location.isDigitalOrderingEnabled
                  ? "Online ordering on"
                  : "Online ordering off"
              }
              tone={location.isDigitalOrderingEnabled ? "positive" : "warning"}
            />
          </div>
          <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-text-muted">Slug</dt>
            <dd className="text-text-secondary">{location.slug}</dd>
          </dl>
        </Card>
      </AdminSection>

      <AdminSection
        title="Assigned menu"
        description="The active menu customers see when ordering from this location."
      >
        {location.assignedMenu ? (
          <Card className="flex flex-col gap-1">
            <span className="text-base font-medium text-text-primary">
              {location.assignedMenu.name}
            </span>
            <span className="text-sm text-text-secondary">
              {location.assignedMenu.productCount} active{" "}
              {location.assignedMenu.productCount === 1 ? "product" : "products"}
            </span>
            <span className="text-xs text-text-muted">
              {location.assignedMenu.slug}
            </span>
          </Card>
        ) : (
          <AdminEmptyState
            title="No menu assigned"
            description="This location has no active assigned menu, so customers can't order from it online."
          />
        )}
      </AdminSection>

      <BackLink href="/admin/locations">Back to locations</BackLink>
    </AdminPage>
  );
}
