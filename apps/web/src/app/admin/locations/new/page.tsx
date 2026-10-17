import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminLocations } from "@/lib/internal-auth/admin-locations";
import { can } from "@/lib/admin/capabilities";
import { countryOptions, timeZoneOptions } from "@/lib/admin/location-profile";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { AdminEmptyState, AdminForbidden } from "@/components/admin/states";
import { ButtonLink } from "@/components/admin/Button";
import { LocationProfileForm } from "@/components/admin/LocationProfileForm";

// SC4d — add the business's first location (`locations.create`, corporate).
// The API allows a business its first location only for now; when it
// already has one, this page says so and links to it instead of a form the
// API would refuse.
export default async function NewLocationPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const breadcrumbs = [
    { label: "Locations", href: "/admin/locations" },
    { label: "Add location" },
  ];
  const header = (
    <AdminPageHeader
      title="Add your location"
      description="Where your customers find you."
      breadcrumbs={breadcrumbs}
    />
  );

  if (!can(session.authorization.capabilities, "locations.create")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden
          title="You can't add locations"
          description="Adding a location is done by your business's owner or administrators."
        />
      </AdminPage>
    );
  }

  const existing = await getAdminLocations();
  if (existing.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (existing.outcome === "success" && existing.locations.length > 0) {
    return (
      <AdminPage>
        {header}
        <AdminEmptyState
          title="Your business already has its location"
          description="Adding more locations isn't available yet. You can update your location's details at any time."
          action={
            <ButtonLink href={`/admin/locations/${existing.locations[0].id}`}>
              Open your location
            </ButtonLink>
          }
        />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <LocationProfileForm
        mode="create"
        countries={countryOptions()}
        timeZones={timeZoneOptions()}
      />
    </AdminPage>
  );
}
