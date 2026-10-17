import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import {
  getAdminGettingStarted,
  getAdminLocation,
} from "@/lib/internal-auth/admin-locations";
import { can, canAtLocation, isCorporateFor } from "@/lib/admin/capabilities";
import { ORDERING_ON_NOT_LIVE } from "@/lib/admin/getting-started";
import { AdminPage, AdminSection } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
  AdminNotFound,
} from "@/components/admin/states";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { LocationOrderingControl } from "@/components/admin/LocationOrderingControl";
import { ButtonLink } from "@/components/admin/Button";
import { BackLink } from "@/components/BackLink";
import { Card } from "@/components/Card";
import { addressLines, timeZoneLabel } from "@/lib/admin/location-profile";
import { openingHoursSummary } from "@/lib/admin/opening-hours";

// Admin Location detail (Milestone 5D-1 read; 5D-2 adds the Online Ordering
// control and the Edit location action). Server component. Authorization is
// the API's: `getAdminLocation` hits the guarded
// `/api/v1/admin/locations/:id` route, which checks the caller's scope for
// `locations.view` before the row is read — a location outside scope is a
// 403 here, surfaced as AdminForbidden (never a silent switch to another
// location). The capability checks below only decide whether to render a
// control the user could actually use; the API re-checks every action.
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

  const capabilities = session.authorization.capabilities;
  const breadcrumbs = [
    { label: "Locations", href: "/admin/locations" },
    { label: "Location" },
  ];

  if (!can(capabilities, "locations.view")) {
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
  const canManageOrdering = canAtLocation(
    capabilities,
    "locations.manage_digital_ordering",
    location.id,
  );
  const canEdit = can(capabilities, "locations.edit");
  const canManagePricing = canAtLocation(
    capabilities,
    "catalog.overrides.manage",
    location.id,
  );
  // SC4d — choosing the location's menu changes menu composition, a
  // corporate task (`catalog.menu.manage`, plus `catalog.view` to list menus).
  const canChooseMenu =
    can(capabilities, "catalog.menu.manage") && can(capabilities, "catalog.view");
  const address = addressLines(location.profile);
  // SC4d — whether customers can reach this business online yet (corporate
  // viewers; for anyone else the note is simply not shown).
  const setup = isCorporateFor(capabilities, "locations.view")
    ? await getAdminGettingStarted()
    : null;

  return (
    <AdminPage>
      <AdminPageHeader
        title={location.name}
        breadcrumbs={[
          { label: "Locations", href: "/admin/locations" },
          { label: location.name },
        ]}
        actions={
          canEdit ? (
            <ButtonLink href={`/admin/locations/${location.id}/edit`}>
              Edit location
            </ButtonLink>
          ) : undefined
        }
      />

      <AdminSection title="Location status">
        <Card className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-text-primary">
                Active
              </span>
              <StatusBadge
                label={location.isActive ? "Active" : "Inactive"}
                tone={location.isActive ? "positive" : "neutral"}
              />
            </div>
            <p className="text-sm text-text-secondary">
              {location.isActive
                ? "Customers can find this location when they order online."
                : "This location is hidden from customers."}
            </p>
          </div>

          <div
            id="online-ordering"
            className="scroll-mt-24 border-t border-border-default pt-4"
          >
            <div className="mb-1.5 text-sm font-medium text-text-primary">
              Online ordering
            </div>
            {canManageOrdering ? (
              <LocationOrderingControl
                locationId={location.id}
                initialEnabled={location.isDigitalOrderingEnabled}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge
                  label={location.isDigitalOrderingEnabled ? "On" : "Off"}
                  tone={
                    location.isDigitalOrderingEnabled ? "positive" : "warning"
                  }
                />
                <span className="text-sm text-text-secondary">
                  {location.isDigitalOrderingEnabled
                    ? "This location is accepting online orders."
                    : "This location isn't accepting online orders right now."}
                </span>
              </div>
            )}
            {location.isDigitalOrderingEnabled && setup && !setup.storefrontLive ? (
              <p className="mt-2 text-sm text-text-secondary">
                {ORDERING_ON_NOT_LIVE}
              </p>
            ) : null}
          </div>
        </Card>
      </AdminSection>

      <AdminSection
        title="Details"
        description="Address, time zone and how customers can reach this location."
      >
        <Card className="flex flex-col gap-3">
          {address.length > 0 || location.profile.phone || location.profile.timeZone ? (
            <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-text-secondary">Address</dt>
              <dd className="text-text-primary">
                {address.length > 0
                  ? address.map((line) => <div key={line}>{line}</div>)
                  : "Not set"}
              </dd>
              <dt className="text-text-secondary">Phone</dt>
              <dd className="text-text-primary">
                {location.profile.phone ?? "Not set"}
              </dd>
              <dt className="text-text-secondary">Time zone</dt>
              <dd className="text-text-primary">
                {location.profile.timeZone
                  ? timeZoneLabel(location.profile.timeZone)
                  : "Not set"}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-text-secondary">
              No address, phone or time zone yet.
            </p>
          )}
          {canEdit ? (
            <div>
              <ButtonLink href={`/admin/locations/${location.id}/profile`}>
                {address.length > 0 ? "Edit details" : "Add details"}
              </ButtonLink>
            </div>
          ) : null}
        </Card>
      </AdminSection>

      <AdminSection
        title="Opening hours"
        description={
          location.profile.timeZone
            ? `In ${timeZoneLabel(location.profile.timeZone)} time. Shown for information — online ordering doesn't follow these hours yet.`
            : "Shown for information — online ordering doesn't follow these hours yet."
        }
      >
        <Card className="flex flex-col gap-3">
          {location.openingHours.isSet ? (
            <ul className="flex flex-col gap-1 text-sm text-text-primary">
              {openingHoursSummary(location.openingHours).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-text-secondary">
              Opening hours aren&apos;t set yet.
            </p>
          )}
          {canEdit ? (
            <div>
              <ButtonLink href={`/admin/locations/${location.id}/hours`}>
                {location.openingHours.isSet ? "Edit hours" : "Set hours"}
              </ButtonLink>
            </div>
          ) : null}
        </Card>
      </AdminSection>

      <AdminSection
        title="Assigned menu"
        description="The menu customers see when ordering from this location."
      >
        {location.assignedMenu ? (
          <Card className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-base font-medium text-text-primary">
                {location.assignedMenu.name}
              </span>
              <span className="text-sm text-text-secondary">
                {location.assignedMenu.productCount} active{" "}
                {location.assignedMenu.productCount === 1 ? "item" : "items"}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {canManagePricing ? (
                <ButtonLink
                  href={`/admin/locations/${location.id}/menu`}
                  variant="secondary"
                >
                  Manage menu &amp; pricing
                </ButtonLink>
              ) : null}
              {canChooseMenu ? (
                <ButtonLink
                  href={`/admin/locations/${location.id}/choose-menu`}
                  variant="secondary"
                >
                  Change menu
                </ButtonLink>
              ) : null}
            </div>
          </Card>
        ) : (
          <AdminEmptyState
            title="No menu assigned"
            description="This location has no menu yet, so customers can't order from it online."
            action={
              canChooseMenu ? (
                <ButtonLink href={`/admin/locations/${location.id}/choose-menu`}>
                  Choose a menu
                </ButtonLink>
              ) : undefined
            }
          />
        )}
      </AdminSection>

      <p className="text-xs text-text-muted">Web address: {location.slug}</p>

      <BackLink href="/admin/locations">Back to locations</BackLink>
    </AdminPage>
  );
}
