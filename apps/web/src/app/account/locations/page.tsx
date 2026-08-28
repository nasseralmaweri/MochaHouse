import Link from "next/link";
import { redirect } from "next/navigation";
import type { LocationSummary } from "@mocha-house/contracts";
import { getCustomerSessionToken } from "@/lib/auth/session";
import { getPreferredLocations } from "@/lib/auth/locations";
import { getLocations } from "@/lib/api";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";
import { RemovePreferredLocationButton } from "./RemovePreferredLocationButton";
import { AddPreferredLocationForm } from "./AddPreferredLocationForm";

// Preferred locations are admin-mutable (a location can be deactivated or
// have digital ordering toggled at any time), so this must render per
// request.
export const dynamic = "force-dynamic";

export default async function PreferredLocationsPage() {
  const token = await getCustomerSessionToken();
  if (!token) {
    redirect("/account/sign-in");
  }

  const preferredResult = await getPreferredLocations(token);
  if (preferredResult.outcome === "unauthorized") {
    redirect("/account/sign-in");
  }

  const preferred =
    preferredResult.outcome === "success" ? preferredResult.locations : [];
  const loadError = preferredResult.outcome === "error";

  // Authoritative list of active locations (public endpoint) minus the ones
  // already preferred — the customer never types a store name.
  let addable: LocationSummary[] = [];
  try {
    const all = await getLocations();
    const preferredIds = new Set(preferred.map((l) => l.id));
    addable = all.filter((l) => !preferredIds.has(l.id));
  } catch {
    // Non-fatal: the preferred list still renders; the add picker just
    // won't be available this load.
    addable = [];
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Preferred locations"
        subtitle="Save the Mocha House locations you order from most."
      />

      {loadError ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          We couldn&apos;t load your preferred locations. Please try again later.
        </Card>
      ) : preferred.length === 0 ? (
        <p className="text-sm text-text-muted">
          You haven&apos;t saved any locations yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {preferred.map((location) => (
            <li key={location.id}>
              <Card className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-base font-semibold text-text-primary">
                      {location.name}
                    </span>
                    <span
                      className={`text-xs font-medium ${
                        location.isDigitalOrderingEnabled
                          ? "text-status-success"
                          : "text-text-muted"
                      }`}
                    >
                      {location.isDigitalOrderingEnabled
                        ? "Ordering available"
                        : "Ordering unavailable right now"}
                    </span>
                  </div>
                  <RemovePreferredLocationButton
                    locationId={location.id}
                    locationName={location.name}
                  />
                </div>

                {location.isDigitalOrderingEnabled ? (
                  <Link
                    href={`/order/menu?location=${location.id}`}
                    className="flex min-h-11 items-center justify-between rounded-xl border border-border-default bg-surface-card px-4 py-3 text-sm font-medium text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    Order from this location
                    <span aria-hidden="true">→</span>
                  </Link>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-3 border-t border-border-default pt-6">
        <AddPreferredLocationForm addable={addable} />
      </div>

      <BackLink href="/account">Back to account</BackLink>
    </main>
  );
}
