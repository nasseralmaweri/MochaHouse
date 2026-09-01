import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  getInternalSession,
  ADMIN_LOCATION_COOKIE,
} from "@/lib/internal-auth/session";
import { getActiveStoreOrders } from "@/lib/internal-auth/admin-orders";
import { getOpeningChecklist } from "@/lib/internal-auth/admin-operations";
import { formatChecklistProgress } from "@/lib/admin/opening-checklist";
import { can } from "@/lib/admin/capabilities";
import { digitalOrderingAttentionItems } from "@/lib/admin/attention";
import { resolveLocationContext } from "@/lib/admin/location-context";
import {
  formatOperationsToday,
  resolveOperationsTodayView,
} from "@/lib/admin/operations-today";
import { AdminPage, AdminSection } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
} from "@/components/admin/states";
import { NeedsAttention } from "@/components/admin/NeedsAttention";
import { Card } from "@/components/Card";
import { ButtonLink } from "@/components/admin/Button";
import { isActiveOrderStatus } from "@mocha-house/domain";
import type { StoreOrderSummary } from "@mocha-house/contracts";

// Admin → Operations → Today (Milestone 6A). The Store Operations
// workspace: the first, deliberately small page. It shows only signals that
// ALREADY exist — the location's "needs attention" items and, for a viewer
// who can see them, the live order snapshot. There is no task / checklist /
// issue data yet; those arrive in later slices.
//
// `operations.view` gates the page. It never, on its own, reveals order
// information: the snapshot is shown only when the viewer also holds
// `orders.view` for this location, and the underlying /admin/orders API
// still enforces that independently.

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

export default async function OperationsTodayPage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string }>;
}) {
  const session = await getInternalSession();
  if (!session) {
    redirect("/internal/sign-in");
  }

  const { isCorporate, locations, capabilities } = session.authorization;

  const header = (
    <AdminPageHeader
      title="Operations"
      description="Your store's operational picture for today."
    />
  );

  if (!can(capabilities, "operations.view")) {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  const { location: urlLocationId } = await searchParams;
  const cookieStore = await cookies();
  const cookieLocationId = cookieStore.get(ADMIN_LOCATION_COOKIE)?.value ?? null;

  const locationContext = resolveLocationContext({
    authorizedLocations: locations,
    isCorporate,
    urlLocationId: urlLocationId ?? null,
    cookieLocationId,
  });

  const view = resolveOperationsTodayView({ locationContext, capabilities });

  if (view.kind === "forbidden-location") {
    return (
      <AdminPage>
        {header}
        <AdminForbidden
          title="You're not assigned to that location"
          description="The location in this link isn't in your assigned scope. Pick one of your locations from the selector above."
        />
      </AdminPage>
    );
  }

  if (view.kind === "no-location") {
    return (
      <AdminPage>
        {header}
        <AdminEmptyState
          title="No location assigned"
          description="You don't have any locations in your scope yet. An administrator needs to assign one."
        />
      </AdminPage>
    );
  }

  if (view.kind === "pick-location") {
    return (
      <AdminPage>
        <AdminPageHeader
          title="Operations"
          description="Your store's operational picture for today."
          context={{ label: "All locations", kind: "corporate" }}
        />
        <AdminEmptyState
          title="Select a location"
          description="Operations is per store. Choose one from the selector in the top bar to see its day."
        />
      </AdminPage>
    );
  }

  // --- One concrete location ------------------------------------------
  const { location } = view;

  // Reuses the dashboard's digital-ordering attention producer verbatim —
  // already scoped per location to locations.manage_digital_ordering, so a
  // viewer only sees a warning for a store they could actually act on.
  const attention = digitalOrderingAttentionItems(
    locations.filter((l) => l.id === location.id),
    capabilities,
  );

  // The Opening Checklist card — the first real Operations workflow
  // (Milestone 6B). A GET lazily creates today's checklist; the card
  // communicates progress and links into the full page.
  const checklistResult = await getOpeningChecklist(location.id);
  const openingChecklist = (
    <OpeningChecklistCard
      progressLabel={
        checklistResult.outcome === "success"
          ? formatChecklistProgress(checklistResult.checklist.progress)
          : null
      }
      isComplete={
        checklistResult.outcome === "success" &&
        checklistResult.checklist.progress.isComplete
      }
      href={`/admin/operations/opening-checklist?location=${encodeURIComponent(
        location.id,
      )}`}
    />
  );

  let snapshot: React.ReactNode = null;
  if (view.showOrderSnapshot) {
    const result = await getActiveStoreOrders(location.id);
    if (result.outcome === "success") {
      const active = result.orders.filter((order) =>
        isActiveOrderStatus(order.status),
      );
      snapshot = (
        <OrderSnapshotCard
          orders={active}
          href={`/admin/orders?location=${encodeURIComponent(location.id)}`}
        />
      );
    } else if (result.outcome === "forbidden") {
      // The viewer's scope changed under them, or orders.view was removed.
      // Don't fail the whole page — Operations still works without it.
      snapshot = null;
    } else {
      snapshot = (
        <AdminErrorState description="Couldn't load the order queue for this location." />
      );
    }
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="Operations"
        description="Your store's operational picture for today."
        context={{ label: location.name, kind: "location" }}
      />

      <AdminSection title={view.locationHeading}>
        <Card tone="subtle" className="text-sm text-text-secondary">
          {formatOperationsToday(new Date())}
        </Card>
      </AdminSection>

      <AdminSection title="Opening checklist">{openingChecklist}</AdminSection>

      <AdminSection title="Needs attention">
        <NeedsAttention items={attention} />
      </AdminSection>

      {snapshot ? (
        <AdminSection title="Store snapshot">{snapshot}</AdminSection>
      ) : null}
    </AdminPage>
  );
}

function OpeningChecklistCard({
  progressLabel,
  isComplete,
  href,
}: {
  progressLabel: string | null;
  isComplete: boolean;
  href: string;
}) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-base font-semibold text-text-primary">
          Opening Checklist
        </span>
        {progressLabel ? (
          <span className="text-sm text-text-secondary">
            {isComplete ? "Complete — " : ""}
            {progressLabel}
          </span>
        ) : (
          <span className="text-sm text-text-muted">
            Open the checklist to see today&rsquo;s progress.
          </span>
        )}
      </div>
      <ButtonLink href={href} variant="secondary">
        Open checklist
      </ButtonLink>
    </Card>
  );
}

function OrderSnapshotCard({
  orders,
  href,
}: {
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
          active order{orders.length === 1 ? "" : "s"}
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
