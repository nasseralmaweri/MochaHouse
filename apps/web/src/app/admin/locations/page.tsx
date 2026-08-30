import Link from "next/link";
import { redirect } from "next/navigation";
import { getInternalSession } from "@/lib/internal-auth/session";
import { getAdminLocations } from "@/lib/internal-auth/admin-locations";
import { can } from "@/lib/admin/capabilities";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
} from "@/components/admin/states";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { Card } from "@/components/Card";

// Admin Locations list (Milestone 5D-1). Server component, inside the shared
// Admin shell (the /admin layout resolves the session + authorization
// summary). Read-only: no create / edit / digital-ordering controls — those
// are Milestone 5D-2.
//
// The list the API returns is already scope-filtered server-side
// (`locations.view`: CORPORATE sees all, LOCATION sees only its own). The
// `?location=` shell context is a UX preference and is deliberately NOT used
// to filter or authorize anything here.
export default async function AdminLocationsPage() {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const header = (
    <AdminPageHeader
      title="Locations"
      description="Every location within your assigned scope."
    />
  );

  if (!can(session.authorization.capabilities, "locations.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const result = await getAdminLocations();

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
        <AdminErrorState description="Couldn't load locations just now. Please try again." />
      </AdminPage>
    );
  }

  if (result.locations.length === 0) {
    return (
      <AdminPage>
        {header}
        <AdminEmptyState
          title="No locations in your scope"
          description="Your role doesn't cover any locations yet. An administrator needs to assign one."
        />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}
      <ul className="flex flex-col gap-3">
        {result.locations.map((location) => (
          <li key={location.id}>
            <Link
              href={`/admin/locations/${location.id}`}
              className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <Card className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-base font-semibold text-text-primary">
                    {location.name}
                  </span>
                  <span aria-hidden="true" className="text-text-muted">
                    →
                  </span>
                </div>
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
                    tone={
                      location.isDigitalOrderingEnabled ? "positive" : "warning"
                    }
                  />
                  <span className="text-xs text-text-muted">{location.slug}</span>
                </div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </AdminPage>
  );
}
