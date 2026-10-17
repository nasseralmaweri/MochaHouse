import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminLocation } from "@/lib/internal-auth/admin-locations";
import { getAdminMenus } from "@/lib/internal-auth/admin-catalog";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { LocationMenuChooser } from "@/components/admin/LocationMenuChooser";
import { BackLink } from "@/components/BackLink";

// SC4d — choose the menu a location sells from. Creating or assigning a
// menu changes menu composition for the business, so it needs the
// corporate `catalog.menu.manage` (and `catalog.view` to list menus); the
// API re-checks both and that the location and menu are this business's.
export default async function ChooseLocationMenuPage({
  params,
}: {
  params: Promise<{ locationId: string }>;
}) {
  const { locationId } = await params;
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }
  const capabilities = session.authorization.capabilities;
  const detailHref = `/admin/locations/${locationId}`;
  const breadcrumbs = [
    { label: "Locations", href: "/admin/locations" },
    { label: "Location", href: detailHref },
    { label: "Menu" },
  ];

  if (
    !can(capabilities, "catalog.menu.manage") ||
    !can(capabilities, "catalog.view")
  ) {
    return (
      <AdminPage>
        <AdminPageHeader title="Choose the menu" breadcrumbs={breadcrumbs} />
        <AdminForbidden
          title="You can't change menus"
          description="Menus are managed by your business's owner or administrators."
        />
        <BackLink href={detailHref}>Back to location</BackLink>
      </AdminPage>
    );
  }

  const [location, menus] = await Promise.all([
    getAdminLocation(locationId),
    getAdminMenus(),
  ]);
  if (location.outcome === "unauthenticated" || menus.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (location.outcome === "forbidden" || location.outcome === "not-found") {
    return (
      <AdminPage>
        <AdminPageHeader title="Choose the menu" breadcrumbs={breadcrumbs} />
        <AdminNotFound
          title="Location not found"
          description="This location doesn't exist, or it isn't in your scope."
          backHref="/admin/locations"
          backLabel="Back to locations"
        />
      </AdminPage>
    );
  }
  if (location.outcome !== "success" || menus.outcome !== "success") {
    return (
      <AdminPage>
        <AdminPageHeader title="Choose the menu" breadcrumbs={breadcrumbs} />
        <AdminErrorState description="Couldn't load your menus just now. Please try again." />
        <BackLink href={detailHref}>Back to location</BackLink>
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="Choose the menu"
        description={`The menu customers will order from at ${location.location.name}.`}
        breadcrumbs={[
          { label: "Locations", href: "/admin/locations" },
          { label: location.location.name, href: detailHref },
          { label: "Menu" },
        ]}
      />
      <LocationMenuChooser
        locationId={location.location.id}
        menus={menus.data}
        currentMenuId={location.location.assignedMenu?.id ?? null}
      />
    </AdminPage>
  );
}
