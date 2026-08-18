import Link from "next/link";
import type { LocationSummary } from "@mocha-house/contracts";
import { getLocations } from "@/lib/api";

// Location availability and digital-ordering state are admin-mutable at
// runtime, so this page must be rendered per-request, not baked in at
// build time.
export const dynamic = "force-dynamic";

export default async function OrderLocationPage() {
  const locations = await getLocations();

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
          Choose a location
        </h1>
        <p className="text-sm text-text-secondary">
          Select a Mocha House location to start your order.
        </p>
      </header>

      {locations.length === 0 ? (
        <p className="text-sm text-text-muted">
          No locations are available right now.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {locations.map((location) => (
            <li key={location.id}>
              <LocationListItem location={location} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function LocationListItem({ location }: { location: LocationSummary }) {
  const available = location.isDigitalOrderingEnabled;

  const card = (
    <div
      className={`flex min-h-11 items-center justify-between gap-4 rounded-xl border border-border-default px-4 py-4 ${
        available ? "bg-surface-card" : "bg-surface-subtle"
      }`}
    >
      <span
        className={`text-base font-medium ${
          available ? "text-text-primary" : "text-text-muted"
        }`}
      >
        {location.name}
      </span>
      <OrderingStatusBadge available={available} />
    </div>
  );

  if (!available) {
    return (
      <div aria-disabled="true" className="cursor-not-allowed">
        {card}
      </div>
    );
  }

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
      {available ? "Ordering available" : "Ordering unavailable"}
    </span>
  );
}
