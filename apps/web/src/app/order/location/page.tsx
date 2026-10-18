import Link from "next/link";
import type { LocationSummary } from "@mocha-house/contracts";
import { getLocations } from "@/lib/api";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { named, requireStorefrontProfile } from "@/lib/storefront-profile";

// Location availability and digital-ordering state are admin-mutable at
// runtime, so this page must be rendered per-request, not baked in at
// build time.
export const dynamic = "force-dynamic";

export default async function OrderLocationPage() {
  const profile = await requireStorefrontProfile();
  const locations = await getLocations();

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Choose a location"
        subtitle={
          profile.orderingAvailable
            ? named(
                profile,
                "Select a {name} location to start your order.",
                "Select a location to start your order.",
              )
            : named(
                profile,
                "Browse {name}'s locations and menus. Online ordering isn't available right now.",
                "Browse locations and menus. Online ordering isn't available right now.",
              )
        }
      />

      {locations.length === 0 ? (
        <p className="text-sm text-text-muted">
          No locations are available right now.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {locations.map((location) => (
            <li key={location.id}>
              <LocationListItem
                location={location}
                businessOrdering={profile.orderingAvailable}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

// SC4f-3b (owner decision J6) — every location can be browsed; only those
// taking online orders (while the business takes orders) offer ordering.
function LocationListItem({
  location,
  businessOrdering,
}: {
  location: LocationSummary;
  businessOrdering: boolean;
}) {
  const available = location.isDigitalOrderingEnabled && businessOrdering;

  const card = (
    <Card
      tone={available ? "default" : "subtle"}
      className="flex min-h-11 items-center justify-between gap-4"
    >
      <span
        className={`text-base font-medium ${
          available ? "text-text-primary" : "text-text-muted"
        }`}
      >
        {location.name}
      </span>
      <OrderingStatusBadge available={available} />
    </Card>
  );

  return (
    <Link
      href={`/order/menu?location=${location.id}`}
      className="block rounded-xl transition active:scale-[0.99] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      {card}
    </Link>
  );
}

function OrderingStatusBadge({ available }: { available: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium ${
        available
          ? "bg-status-success/10 text-status-success"
          : "bg-surface-card text-text-muted"
      }`}
    >
      {available ? "Ordering available" : "Browse menu"}
    </span>
  );
}
