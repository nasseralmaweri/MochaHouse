import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getInternalSession, ADMIN_LOCATION_COOKIE } from "@/lib/internal-auth/session";
import { getActiveStoreOrders } from "@/lib/internal-auth/admin-orders";
import { can } from "@/lib/admin/permissions";
import { resolveLocationContext } from "@/lib/admin/location-context";
import { AdminPage, AdminSection } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
} from "@/components/admin/states";
import { NeedsAttention, type AttentionItem } from "@/components/admin/NeedsAttention";
import { Card } from "@/components/Card";
import { ButtonLink } from "@/components/admin/Button";
import { isActiveOrderStatus } from "@mocha-house/domain";
import type { StoreOrderSummary } from "@mocha-house/contracts";

function formatAge(from: string): string {
  const ms = Date.now() - new Date(from).getTime();
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string }>;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const { permissions, isCorporate, locations } = session.authorization;
  const { location: urlLocationId } = await searchParams;
  const cookieStore = await cookies();
  const cookieLocationId = cookieStore.get(ADMIN_LOCATION_COOKIE)?.value ?? null;

  const locationContext = resolveLocationContext({
    authorizedLocations: locations,
    isCorporate,
    urlLocationId: urlLocationId ?? null,
    cookieLocationId,
  });

  // --- Zero operational access -----------------------------------------
  if (permissions.length === 0) {
    return (
      <AdminPage>
        <AdminPageHeader
          title="Dashboard"
          description="Your Mocha House Admin workspace."
        />
        <AdminEmptyState
          title="You don't have operational access yet"
          description="Your internal account is active, but no role has been assigned to it. An administrator needs to grant you a role before you can work in the Admin platform."
        />
      </AdminPage>
    );
  }

  // --- Explicit but unauthorized ?location -----------------------------
  if (locationContext.kind === "forbidden") {
    return (
      <AdminPage>
        <AdminPageHeader title="Dashboard" />
        <AdminForbidden
          title="You're not assigned to that location"
          description="The location in this link isn't in your assigned scope. Pick one of your locations from the selector above."
        />
      </AdminPage>
    );
  }

  const contextLabel =
    locationContext.kind === "corporate"
      ? "All locations"
      : locationContext.kind === "location"
        ? locationContext.location.name
        : undefined;

  // --- Needs Attention: digital ordering disabled ---------------------
  const attention: AttentionItem[] = [];
  if (can(permissions, "locations.manage_digital_ordering")) {
    for (const location of locations) {
      if (!location.isDigitalOrderingEnabled) {
        attention.push({
          id: `digital-ordering-${location.id}`,
          severity: "warning",
          title: "Digital ordering is off",
          description: `${location.name} — customers can't place online orders here.`,
        });
      }
    }
  }

  // --- Store snapshot -------------------------------------------------
  let snapshot: React.ReactNode = null;
  if (can(permissions, "orders.view")) {
    if (locationContext.kind === "location") {
      const locationId = locationContext.location.id;
      const result = await getActiveStoreOrders(locationId);
      if (result.outcome === "success") {
        const active = result.orders.filter((order) =>
          isActiveOrderStatus(order.status),
        );
        snapshot = (
          <OrderSnapshotCard
            locationName={locationContext.location.name}
            orders={active}
            href={`/admin/orders?location=${encodeURIComponent(locationId)}`}
          />
        );
      } else if (result.outcome === "forbidden") {
        snapshot = <AdminForbidden />;
      } else {
        snapshot = (
          <AdminErrorState description="Couldn't load the order queue for this location." />
        );
      }
    } else if (locationContext.kind === "corporate") {
      snapshot = (
        <AdminEmptyState
          title="Select a location to see its queue"
          description="Order queue snapshots are per location. Choose one from the selector above."
        />
      );
    }
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="Dashboard"
        description="What needs your attention right now."
        context={
          contextLabel
            ? {
                label: contextLabel,
                kind:
                  locationContext.kind === "corporate"
                    ? "corporate"
                    : "location",
              }
            : undefined
        }
      />

      <AdminSection title="Needs attention">
        <NeedsAttention items={attention} />
      </AdminSection>

      {snapshot ? (
        <AdminSection title="Store snapshot">{snapshot}</AdminSection>
      ) : null}
    </AdminPage>
  );
}

function OrderSnapshotCard({
  locationName,
  orders,
  href,
}: {
  locationName: string;
  orders: StoreOrderSummary[];
  href: string;
}) {
  const oldest = orders.reduce<string | null>((acc, order) => {
    if (!acc) return order.createdAt;
    return new Date(order.createdAt) < new Date(acc) ? order.createdAt : acc;
  }, null);

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold text-text-primary">
          {orders.length}
        </span>
        <span className="text-sm text-text-secondary">
          active order{orders.length === 1 ? "" : "s"} · {locationName}
        </span>
      </div>
      {oldest ? (
        <p className="text-sm text-text-secondary">
          Oldest active order: {formatAge(oldest)} ago
        </p>
      ) : (
        <p className="text-sm text-text-muted">The queue is clear.</p>
      )}
      <ButtonLink href={href} variant="secondary">
        Open the order queue
      </ButtonLink>
    </Card>
  );
}
