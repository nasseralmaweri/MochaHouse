"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { LocationSummary, OrderStatus, StoreOrderSummary } from "@mocha-house/contracts";
import { isActiveOrderStatus } from "@mocha-house/domain";
import {
  advanceStoreOrderStatusFromBrowser,
  getActiveStoreOrdersFromBrowser,
  getLocationsFromBrowser,
} from "@/lib/api-client";
import { formatPrice } from "@/lib/money";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";

// INTERNAL: the /admin server layout (app/admin/layout.tsx) gate-keeps this
// route to an ACTIVE internal user (Milestone 5A), and every API call below
// goes through the server-side proxy that forwards the HttpOnly internal
// session cookie. There is no role/permission/scope model yet (5B), so any
// ACTIVE internal user can act on any location they pick.

const NEXT_ACTION_LABEL: Record<OrderStatus, string | null> = {
  RECEIVED: "Accept",
  ACCEPTED: "Start preparing",
  PREPARING: "Mark ready",
  READY: "Complete",
  COMPLETED: null,
};

const STATUS_LABEL: Record<OrderStatus, string> = {
  RECEIVED: "Received",
  ACCEPTED: "Accepted",
  PREPARING: "Preparing",
  READY: "Ready",
  COMPLETED: "Completed",
};

export default function AdminOrdersPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
          <PageHeader title="Store orders" />
        </main>
      }
    >
      <AdminOrdersPageContent />
    </Suspense>
  );
}

function AdminOrdersPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const locationId = searchParams.get("location");

  const [locations, setLocations] = useState<LocationSummary[]>([]);
  // null = not loaded yet for the current location (distinct from "loaded,
  // zero results"), which is what drives the loading/empty text below
  // without a separate boolean flag being set synchronously in an effect.
  const [orders, setOrders] = useState<StoreOrderSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    getLocationsFromBrowser()
      .then(setLocations)
      .catch(() => setLoadError("Could not load locations."));
  }, []);

  useEffect(() => {
    if (!locationId) return;
    let cancelled = false;
    getActiveStoreOrdersFromBrowser(locationId)
      .then((result) => {
        if (cancelled) return;
        setOrders(result);
        setLoadError(null);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Could not load orders for this location.");
      });
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  // Only for explicit user-triggered refreshes (button click, or after a
  // conflict) — never called from the effect above, so setting state
  // synchronously here is a normal event-handler update, not an effect one.
  async function refreshOrders() {
    if (!locationId) return;
    try {
      const result = await getActiveStoreOrdersFromBrowser(locationId);
      setOrders(result);
      setLoadError(null);
    } catch {
      setLoadError("Could not load orders for this location.");
    }
  }

  function handleLocationChange(nextLocationId: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (nextLocationId) {
      params.set("location", nextLocationId);
    } else {
      params.delete("location");
    }
    router.push(`/admin/orders?${params.toString()}`);
  }

  async function handleAdvance(order: StoreOrderSummary) {
    if (!locationId) return;
    const outcome = await advanceStoreOrderStatusFromBrowser(
      order.orderId,
      locationId,
      order.status,
    );

    if (outcome.outcome === "conflict") {
      // Someone else already acted on this order — resync with the server
      // rather than guessing what the current state is.
      setLoadError(outcome.message);
      await refreshOrders();
      return;
    }
    if (outcome.outcome === "error") {
      setLoadError(outcome.message);
      return;
    }

    const nextStatus = outcome.result.status;
    setOrders((current) => {
      if (!current) return current;
      if (!isActiveOrderStatus(nextStatus)) {
        // Completed orders leave the active queue immediately, without
        // waiting on a full refetch.
        return current.filter((o) => o.orderId !== order.orderId);
      }
      return current.map((o) =>
        o.orderId === order.orderId ? { ...o, status: nextStatus } : o,
      );
    });
  }

  const selectedLocation = locations.find((l) => l.id === locationId);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Store orders"
        subtitle={selectedLocation ? selectedLocation.name : "Select a location"}
      />

      <Card className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-sm text-text-secondary">
          Location
          <select
            value={locationId ?? ""}
            onChange={(event) => handleLocationChange(event.target.value)}
            className="min-h-11 rounded-xl border border-border-default bg-surface-card px-3 py-2 text-base text-text-primary"
          >
            <option value="">Select a location…</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
        </label>
      </Card>

      {!locationId ? (
        <p className="text-sm text-text-muted">
          Choose a location above to see its active orders.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-text-muted">
              {orders === null
                ? "Loading…"
                : `${orders.length} active order${orders.length === 1 ? "" : "s"}`}
            </p>
            <button
              type="button"
              onClick={refreshOrders}
              className="text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              Refresh
            </button>
          </div>

          {loadError ? (
            <Card tone="subtle" className="text-sm text-status-warning">
              {loadError}
            </Card>
          ) : null}

          {orders !== null && orders.length === 0 && !loadError ? (
            <p className="text-sm text-text-muted">No active orders right now.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {(orders ?? []).map((order) => (
                <li key={order.orderId}>
                  <OrderCard
                    order={order}
                    locationId={locationId}
                    onAdvance={() => handleAdvance(order)}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

function OrderCard({
  order,
  locationId,
  onAdvance,
}: {
  order: StoreOrderSummary;
  locationId: string;
  onAdvance: () => void;
}) {
  const [advancing, setAdvancing] = useState(false);
  const nextActionLabel = NEXT_ACTION_LABEL[order.status];

  async function handleClick() {
    setAdvancing(true);
    try {
      await onAdvance();
    } finally {
      setAdvancing(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link
            href={`/admin/orders/${order.orderId}?location=${locationId}`}
            className="text-base font-semibold text-text-primary underline-offset-2 hover:underline"
          >
            #{order.orderNumber}
          </Link>
          <span className="text-sm text-text-secondary">{order.guestName}</span>
          <span className="text-xs text-text-muted">
            {new Date(order.createdAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        </div>
        <StatusBadge status={order.status} />
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
          <button
            type="button"
            onClick={handleClick}
            disabled={advancing}
            className="flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-4 py-2 text-sm font-semibold text-status-success disabled:bg-surface-subtle disabled:text-text-muted"
          >
            {advancing ? "Updating…" : nextActionLabel}
          </button>
        ) : null}
      </div>
    </Card>
  );
}

function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-surface-subtle px-2.5 py-1 text-xs font-medium text-text-secondary">
      {STATUS_LABEL[status]}
    </span>
  );
}
