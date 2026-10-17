import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminLocation } from "@/lib/internal-auth/admin-locations";
import { can } from "@/lib/admin/capabilities";
import { countryOptions, timeZoneOptions } from "@/lib/admin/location-profile";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { LocationProfileForm } from "@/components/admin/LocationProfileForm";
import { BackLink } from "@/components/BackLink";

// SC4d — a location's name, address, time zone and phone
// (`locations.edit`, corporate; the API re-checks).
export default async function LocationProfilePage({
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
    { label: "Details" },
  ];

  if (!can(session.authorization.capabilities, "locations.edit")) {
    return (
      <AdminPage>
        <AdminPageHeader title="Location details" breadcrumbs={breadcrumbs} />
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
  if (result.outcome === "forbidden" || result.outcome === "not-found") {
    return (
      <AdminPage>
        <AdminPageHeader title="Location details" breadcrumbs={breadcrumbs} />
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
        <AdminPageHeader title="Location details" breadcrumbs={breadcrumbs} />
        <AdminErrorState description="Couldn't load this location just now. Please try again." />
        <BackLink href={detailHref}>Back to location</BackLink>
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="Location details"
        description="Address, time zone and how customers can reach you."
        breadcrumbs={[
          { label: "Locations", href: "/admin/locations" },
          { label: result.location.name, href: detailHref },
          { label: "Details" },
        ]}
      />
      <LocationProfileForm
        mode="edit"
        location={result.location}
        countries={countryOptions()}
        timeZones={timeZoneOptions()}
      />
    </AdminPage>
  );
}
