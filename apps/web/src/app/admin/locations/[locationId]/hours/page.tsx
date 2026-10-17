import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminLocation } from "@/lib/internal-auth/admin-locations";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { ButtonLink } from "@/components/admin/Button";
import { OpeningHoursForm } from "@/components/admin/OpeningHoursForm";
import { BackLink } from "@/components/BackLink";

// SC4d — a location's weekly opening hours (`locations.edit`, corporate; the
// API re-checks). Hours are local to the location's time zone, so the time
// zone comes first.
export default async function LocationHoursPage({
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
    { label: "Opening hours" },
  ];

  if (!can(session.authorization.capabilities, "locations.edit")) {
    return (
      <AdminPage>
        <AdminPageHeader title="Opening hours" breadcrumbs={breadcrumbs} />
        <AdminForbidden
          title="You can't change opening hours"
          description="Opening hours are set by your business's owner or administrators."
        />
        <BackLink href={detailHref}>Back to location</BackLink>
      </AdminPage>
    );
  }

  const result = await getAdminLocation(locationId);
  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden" || result.outcome === "not-found") {
    return (
      <AdminPage>
        <AdminPageHeader title="Opening hours" breadcrumbs={breadcrumbs} />
        <AdminNotFound
          title="Location not found"
          description="This location doesn't exist, or it isn't in your scope."
          backHref="/admin/locations"
          backLabel="Back to locations"
        />
      </AdminPage>
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        <AdminPageHeader title="Opening hours" breadcrumbs={breadcrumbs} />
        <AdminErrorState description="Couldn't load this location just now. Please try again." />
        <BackLink href={detailHref}>Back to location</BackLink>
      </AdminPage>
    );
  }

  const location = result.location;
  const header = (
    <AdminPageHeader
      title="Opening hours"
      description="The days and times this location is open."
      breadcrumbs={[
        { label: "Locations", href: "/admin/locations" },
        { label: location.name, href: detailHref },
        { label: "Opening hours" },
      ]}
    />
  );

  if (!location.profile.timeZone) {
    return (
      <AdminPage>
        {header}
        <AdminEmptyState
          title="Choose the time zone first"
          description="Opening hours are in the location's own time zone. Add it with the location's details, then come back here."
          action={
            <ButtonLink href={`${detailHref}/profile`}>Add details</ButtonLink>
          }
        />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <OpeningHoursForm
        locationId={location.id}
        timeZone={location.profile.timeZone}
        hours={location.openingHours}
        doneHref={detailHref}
      />
    </AdminPage>
  );
}
