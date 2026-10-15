"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { OrderStatus, StoreOrderSummary } from "@mocha-house/contracts";
import {
  advanceStoreOrderStatusFromBrowser,
  getActiveStoreOrdersFromBrowser,
} from "@/lib/api-client";
import { formatPrice } from "@/lib/money";
import {
  PollingController,
  browserPollingEnv,
} from "@/lib/polling/polling-controller";
import { useNow, usePollingController } from "@/lib/polling/use-polling";
import {
  applyAdvanced,
  arrivalAnnouncement,
  countAwaitingAcceptance,
  describeConnection,
  findArrivals,
  groupOrders,
  orderAgeLabel,
  queueTitle,
} from "@/lib/admin/order-queue";
import { ConnectionBanner } from "@/components/admin/ConnectionBanner";
import { SoundToggle } from "@/components/admin/SoundToggle";
import {
  SoundAlertController,
  browserSoundEnv,
} from "@/lib/admin/sound-alert";
import { Card } from "@/components/Card";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminEmptyState,
  AdminErrorState,
  AdminForbidden,
  AdminLoading,
} from "@/components/admin/states";
import { Button } from "@/components/admin/Button";
import { OrderStatusBadge } from "@/components/admin/StatusBadge";
import { useAdminContext } from "@/components/admin/AdminContext";

const NEXT_ACTION_LABEL: Record<OrderStatus, string | null> = {
  RECEIVED: "Accept",
  ACCEPTED: "Start preparing",
  PREPARING: "Mark ready",
  READY: "Complete",
  COMPLETED: null,
  // Closed orders are terminal: nothing advances from them.
  REJECTED: null,
  CANCELLED: null,
};

// The store order queue, now rendered inside the shared Admin shell. The
// location comes from the shell's authorization-aware context (never the
// public /locations endpoint), and 403 renders AdminForbidden rather than a
// generic error. The order lifecycle / advance / conflict-resync behaviour
// is unchanged from Milestone 5A/5E's predecessor.
export default function AdminOrdersPage() {
  const { can, canAtLocation, locationContext } = useAdminContext();

  if (!can("orders.view")) {
    return (
      <AdminPage>
        <AdminPageHeader title="Orders" />
        <AdminForbidden />
      </AdminPage>
    );
  }

  if (locationContext.kind === "forbidden") {
    return (
      <AdminPage>
        <AdminPageHeader title="Orders" />
        <AdminForbidden
          title="You're not assigned to that location"
          description="The location in this link isn't in your assigned scope. Pick one of your locations from the scope selector at the top of the page."
        />
      </AdminPage>
    );
  }

  if (locationContext.kind === "none") {
    return (
      <AdminPage>
        <AdminPageHeader title="Orders" />
        <AdminEmptyState
          title="No location assigned"
          description="You don't have any locations in your scope yet. An administrator needs to assign one."
        />
      </AdminPage>
    );
  }

  if (locationContext.kind === "corporate") {
    return (
      <AdminPage>
        <AdminPageHeader
          title="Orders"
          context={{ label: "All locations", kind: "corporate" }}
        />
        <AdminEmptyState
          title="Select a location"
          description="The order queue is per location. Choose one from the scope selector at the top of the page."
        />
      </AdminPage>
    );
  }

  // `orders.view` is held somewhere, but not necessarily for THIS location
  // (the location context comes from the general operational-scope set).
  if (!canAtLocation("orders.view", locationContext.location.id)) {
    return (
      <AdminPage>
        <AdminPageHeader
          title="Orders"
          context={{ label: locationContext.location.name, kind: "location" }}
        />
        <AdminForbidden
          title="Not in your scope for orders"
          description="You can view orders at some locations, but not this one. Switch to one of your order locations from the scope selector at the top of the page."
        />
      </AdminPage>
    );
  }

  return (
    // Keyed on the location id so switching location gives OrdersQueue a
    // fresh mount (fresh state) rather than resetting state in an effect.
    <OrdersQueue
      key={locationContext.location.id}
      locationId={locationContext.location.id}
      locationName={locationContext.location.name}
    />
  );
}

// How long an arrival announcement stays in the live region before it is
// cleared, so the next announcement is read even if the wording repeats.
const ANNOUNCEMENT_CLEAR_MS = 6_000;

function OrdersQueue({
  locationId,
  locationName,
}: {
  locationId: string;
  locationName: string;
}) {
  // Ids this screen has already seen. null until the first successful load,
  // so opening the page never announces the existing backlog as "new".
  const knownIds = useRef<Set<string> | null>(null);
  // Orders currently being advanced. A ref (not state) so a second tap in the
  // same tick is refused synchronously, before React re-renders.
  const advancing = useRef<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [arrivedIds, setArrivedIds] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  // Alternates a trailing space so two identical announcements in a row still
  // change the live region and are both spoken.
  const announceFlip = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const now = useNow();
  // Optional audible alert, off until someone taps "Enable sound". Created
  // before the poller so its arrival callback can use it.
  const [sound] = useState(() => new SoundAlertController(browserSoundEnv()));

  const { controller, snapshot } = usePollingController<StoreOrderSummary[]>(
    () =>
      new PollingController<StoreOrderSummary[]>({
        env: browserPollingEnv(),
        fetch: async () => {
          const result = await getActiveStoreOrdersFromBrowser(locationId);
          if (result.outcome === "success") {
            return { outcome: "success", data: result.orders };
          }
          return { outcome: result.outcome };
        },
        onData: (orders) => {
          const arrivals = findArrivals(knownIds.current, orders);
          knownIds.current = new Set(orders.map((o) => o.orderId));
          if (arrivals.length > 0) {
            setArrivedIds((current) => new Set([...current, ...arrivals]));
            announceFlip.current = !announceFlip.current;
            setAnnouncement(
              arrivalAnnouncement(arrivals.length) +
                (announceFlip.current ? String.fromCharCode(160) : ""),
            );
            // Genuinely new arrivals only: the first load passes none, so the
            // existing backlog never makes a sound. One chime per batch.
            void sound.notifyArrivals(arrivals);
          }
        },
      }),
  );

  // A saved "sound on" preference tries to start audio again after a reload;
  // if the browser refuses, the toggle asks for a tap.
  useEffect(() => {
    void sound.prepare();
    // Release the audio context when the queue goes away.
    return () => sound.dispose();
  }, [sound]);

  const orders = snapshot.data;
  const awaiting = orders ? countAwaitingAcceptance(orders) : 0;
  const connectionNotice = describeConnection(snapshot.connection);

  // The tab title carries the count of orders waiting to be accepted, so the
  // queue stays noticeable from another tab. Derived from server state, so a
  // reload loses nothing.
  useEffect(() => {
    const previous = document.title;
    document.title = queueTitle(awaiting);
    return () => {
      document.title = previous;
    };
  }, [awaiting]);

  // Clear a spoken announcement after a moment, so the next one is read even
  // when its wording repeats.
  useEffect(() => {
    if (!announcement) return;
    const handle = window.setTimeout(
      () => setAnnouncement(""),
      ANNOUNCEMENT_CLEAR_MS,
    );
    return () => window.clearTimeout(handle);
  }, [announcement]);

  async function handleAdvance(order: StoreOrderSummary) {
    // Refuse a repeat tap, and refuse any action on data we cannot trust.
    if (advancing.current.has(order.orderId)) return;
    // Checked at tap time against the clock, not only the last render.
    if (!snapshot.actionsAllowed || !controller.canAct()) {
      controller.refreshNow();
      return;
    }
    advancing.current.add(order.orderId);
    setPendingIds(new Set(advancing.current));
    setNotice(null);

    try {
      const outcome = await advanceStoreOrderStatusFromBrowser(
        order.orderId,
        locationId,
        order.status,
      );

      if (outcome.outcome === "forbidden") {
        setNotice("You no longer have permission to update this order.");
        controller.refreshNow();
        return;
      }
      if (outcome.outcome === "conflict") {
        // Someone else already acted — resync rather than guess.
        setNotice(outcome.message);
        controller.refreshNow();
        return;
      }
      if (outcome.outcome === "error") {
        setNotice(outcome.message);
        controller.refreshNow();
        return;
      }

      // Show what the server just confirmed. This also invalidates any poll
      // already in flight (it began before this change), which is then
      // refetched, so an old response can never put the card back.
      const confirmed = outcome.result.status;
      controller.update((current) =>
        applyAdvanced(current, order.orderId, confirmed),
      );
      setArrivedIds((current) => {
        if (!current.has(order.orderId)) return current;
        const next = new Set(current);
        next.delete(order.orderId);
        return next;
      });
      controller.refreshNow();
    } finally {
      advancing.current.delete(order.orderId);
      setPendingIds(new Set(advancing.current));
    }
  }

  const header = (
    <AdminPageHeader
      title="Orders"
      description="Work the live queue for this location."
      context={{ label: locationName, kind: "location" }}
      actions={
        orders !== null && snapshot.connection !== "forbidden" ? (
          <div className="flex flex-wrap items-start justify-end gap-2">
            <SoundToggle controller={sound} />
            <Button
              variant="secondary"
              onClick={() => controller.refreshNow()}
              disabled={snapshot.refreshing}
            >
              {snapshot.refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        ) : undefined
      }
    />
  );

  if (snapshot.connection === "forbidden") {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }

  if (orders === null) {
    return (
      <AdminPage>
        {header}
        {snapshot.connection === "loading" ? (
          <AdminLoading label="Loading orders" />
        ) : (
          <AdminErrorState
            description="Couldn't load the order queue for this location."
            onRetry={() => controller.refreshNow()}
          />
        )}
      </AdminPage>
    );
  }

  const groups = groupOrders(orders);
  const pausedReason = connectionNotice.actionsPausedReason;
  const sectionProps = {
    locationId,
    now,
    pendingIds,
    arrivedIds,
    pausedReason,
    actionsAllowed: snapshot.actionsAllowed,
    onAdvance: handleAdvance,
  };

  return (
    <AdminPage>
      {header}

      <ConnectionBanner
        connection={snapshot.connection}
        lastSuccessAt={snapshot.lastSuccessAt}
        refreshing={snapshot.refreshing}
        onRetry={() => controller.refreshNow()}
      />

      {/* Spoken announcement of new arrivals; visually hidden. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {notice ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          <span role="status">{notice}</span>
        </Card>
      ) : null}

      {pausedReason ? (
        <p id="queue-actions-paused" className="text-sm text-status-error">
          {pausedReason}
        </p>
      ) : null}

      {orders.length === 0 ? (
        <AdminEmptyState
          title="No active orders"
          description="Nothing is in the queue for this location right now."
        />
      ) : (
        <div className="flex flex-col gap-6">
          <QueueSection
            title="New"
            hint="Waiting to be accepted"
            orders={groups.needsAcceptance}
            {...sectionProps}
          />
          <QueueSection
            title="In progress"
            orders={groups.inProgress}
            {...sectionProps}
          />
          <QueueSection
            title="Ready for pickup"
            orders={groups.ready}
            {...sectionProps}
          />
        </div>
      )}
    </AdminPage>
  );
}

function QueueSection({
  title,
  hint,
  orders,
  locationId,
  now,
  pendingIds,
  arrivedIds,
  actionsAllowed,
  pausedReason,
  onAdvance,
}: {
  title: string;
  hint?: string;
  orders: StoreOrderSummary[];
  locationId: string;
  now: number;
  pendingIds: ReadonlySet<string>;
  arrivedIds: ReadonlySet<string>;
  actionsAllowed: boolean;
  pausedReason: string | null;
  onAdvance: (order: StoreOrderSummary) => void;
}) {
  // Always rendered (an empty one shows a quiet line) so sections do not
  // appear and disappear under a finger as orders move between them.
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className="flex items-baseline gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
        {title}
        <span className="text-text-muted">({orders.length})</span>
        {hint ? (
          <span className="text-xs font-normal normal-case text-text-muted">
            {hint}
          </span>
        ) : null}
      </h2>
      {orders.length === 0 ? (
        <p className="text-sm text-text-muted">None right now</p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {orders.map((order) => (
          <li key={order.orderId}>
            <OrderCard
              order={order}
              locationId={locationId}
              now={now}
              isNew={order.status === "RECEIVED"}
              justArrived={arrivedIds.has(order.orderId)}
              busy={pendingIds.has(order.orderId)}
              actionsAllowed={actionsAllowed}
              pausedReason={pausedReason}
              onAdvance={() => onAdvance(order)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function OrderCard({
  order,
  locationId,
  now,
  isNew,
  justArrived,
  busy,
  actionsAllowed,
  pausedReason,
  onAdvance,
}: {
  order: StoreOrderSummary;
  locationId: string;
  now: number;
  isNew: boolean;
  justArrived: boolean;
  busy: boolean;
  actionsAllowed: boolean;
  pausedReason: string | null;
  onAdvance: () => void;
}) {
  const nextActionLabel = NEXT_ACTION_LABEL[order.status];
  const disabled = busy || !actionsAllowed;

  return (
    <Card
      className={`flex flex-col gap-3 ${isNew ? "ring-2 ring-status-warning" : ""}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link
            href={`/admin/orders/${order.orderId}?location=${encodeURIComponent(locationId)}`}
            className="text-base font-semibold text-text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            #{order.orderNumber}
          </Link>
          <span className="text-sm text-text-secondary">{order.guestName}</span>
          <span className="text-xs text-text-muted">
            {new Date(order.createdAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
            {" · "}
            {orderAgeLabel(order.createdAt, now)}
          </span>
        </div>
        <div className="flex flex-col items-end gap-1">
          <OrderStatusBadge status={order.status} />
          {justArrived ? (
            <span className="rounded-full bg-status-warning px-2 py-0.5 text-xs font-semibold text-white">
              New
            </span>
          ) : null}
        </div>
      </div>

      <ul className="flex flex-col gap-1">
        {order.lines.map((line, index) => (
          <li key={index} className="text-sm text-text-primary">
            {line.quantity}× {line.productName}
            {line.selections.length > 0 ? (
              <span className="text-text-muted">
                {" "}
                ({line.selections.map((s) => s.optionNames.join(", ")).join(", ")})
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between border-t border-border-default pt-2">
        <span className="text-sm font-medium text-text-secondary">
          {formatPrice(order.subtotal, order.currency)}
        </span>
        {nextActionLabel ? (
          <Button
            onClick={onAdvance}
            disabled={disabled}
            aria-describedby={
              !actionsAllowed && pausedReason ? "queue-actions-paused" : undefined
            }
            className="min-w-32"
          >
            {busy ? "Updating…" : nextActionLabel}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
