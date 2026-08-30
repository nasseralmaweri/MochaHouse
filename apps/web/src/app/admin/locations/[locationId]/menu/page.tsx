import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminLocationMenu } from "@/lib/internal-auth/admin-catalog";
import { canAtLocation } from "@/lib/admin/capabilities";
import { AdminPage, AdminSection } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { LocationMenuProductRow } from "@/components/admin/LocationMenuProductRow";
import { BackLink } from "@/components/BackLink";

// Manage menu & pricing for one location (Milestone 5D-4). Server component;
// each product row is a small client island. Gated on
// `catalog.overrides.manage` FOR THIS LOCATION — deliberately NOT
// `catalog.view`, so a location manager reaches their own location's
// pricing without corporate catalog access. The screen only ever shows this
// one location and its menu.
export default async function LocationMenuPage({
  params,
}: {
  params: Promise<{ locationId: string }>;
}) {
  const { locationId } = await params;

  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const backHref = `/admin/locations/${locationId}`;
  const breadcrumbs = [
    { label: "Locations", href: "/admin/locations" },
    { label: "Location", href: backHref },
    { label: "Menu & pricing" },
  ];

  if (
    !canAtLocation(
      session.authorization.capabilities,
      "catalog.overrides.manage",
      locationId,
    )
  ) {
    return (
      <AdminPage>
        <AdminPageHeader title="Menu & pricing" breadcrumbs={breadcrumbs} />
        <AdminForbidden
          title="Not in your scope"
          description="You can't manage pricing for this location."
        />
      </AdminPage>
    );
  }

  const result = await getAdminLocationMenu(locationId);

  if (result.outcome === "unauthenticated") {
    redirect("/internal/sign-in");
  }
  if (result.outcome === "forbidden") {
    return (
      <AdminPage>
        <AdminPageHeader title="Menu & pricing" breadcrumbs={breadcrumbs} />
        <AdminForbidden
          title="Not in your scope"
          description="You can't manage pricing for this location."
        />
      </AdminPage>
    );
  }
  if (result.outcome === "not-found") {
    return (
      <AdminPage>
        <AdminPageHeader title="Menu & pricing" breadcrumbs={breadcrumbs} />
        <AdminNotFound
          title="No menu at this location"
          description="This location doesn't have a menu yet, so there's nothing to price."
          backHref={backHref}
          backLabel="Back to location"
        />
      </AdminPage>
    );
  }
  if (result.outcome === "error") {
    return (
      <AdminPage>
        <AdminPageHeader title="Menu & pricing" breadcrumbs={breadcrumbs} />
        <AdminErrorState description="Couldn't load this location's menu just now. Please try again." />
        <BackLink href={backHref}>Back to location</BackLink>
      </AdminPage>
    );
  }

  const { location, menu, products } = result.data;

  return (
    <AdminPage>
      <AdminPageHeader
        title="Menu & pricing"
        description={`${menu.name} — set prices and availability just for ${location.name}.`}
        breadcrumbs={[
          { label: "Locations", href: "/admin/locations" },
          { label: location.name, href: backHref },
          { label: "Menu & pricing" },
        ]}
      />

      <AdminSection title={`Products on ${menu.name}`}>
        {products.length === 0 ? (
          <AdminEmptyState
            title="No products on this menu"
            description="There is nothing to price here yet."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {products.map((product) => (
              <li key={product.productId}>
                <LocationMenuProductRow
                  locationId={location.id}
                  menuId={menu.id}
                  product={product}
                />
              </li>
            ))}
          </ul>
        )}
      </AdminSection>

      <BackLink href={backHref}>Back to location</BackLink>
    </AdminPage>
  );
}
