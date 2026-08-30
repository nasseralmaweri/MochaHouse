"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { OrderStatus, StoreOrderSummary } from "@mocha-house/contracts";
import { isActiveOrderStatus } from "@mocha-house/domain";
import {
  advanceStoreOrderStatusFromBrowser,
  getActiveStoreOrdersFromBrowser,
} from "@/lib/api-client";
import { formatPrice } from "@/lib/money";
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
};

// The store order queue, now rendered inside the shared Admin shell. The
// location comes from the shell's authorization-aware context (never the
// public /locations endpoint), and 403 renders AdminForbidden rather than a
// generic error. The order lifecycle / advance / conflict-resync behaviour
// is unchanged from Milestone 5A/5E's predecessor.
export default function AdminOrdersPage() {
  const { can, locationContext } = useAdminContext();

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
          description="The location in this link isn't in your assigned scope. Pick one of your locations from the selector above."
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
          description="The order queue is per location. Choose one from the selector in the top bar."
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

function OrdersQueue({
  locationId,
  locationName,
}: {
  locationId: string;
  locationName: string;
}) {
  // null = not loaded yet for the current location (distinct from "loaded,
  // zero results").
  const [orders, setOrders] = useState<StoreOrderSummary[] | null>(null);
  const [state, setState] = useState<"ok" | "forbidden" | "error">("ok");
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await getActiveStoreOrdersFromBrowser(locationId);
    if (result.outcome === "forbidden") {
      setState("forbidden");
      return;
    }
    if (result.outcome === "error") {
      setState("error");
      return;
    }
    setState("ok");
    setNotice(null);
    setOrders(result.orders);
  }, [locationId]);

  useEffect(() => {
    let cancelled = false;
    getActiveStoreOrdersFromBrowser(locationId).then((result) => {
      if (cancelled) return;
      if (result.outcome === "forbidden") {
        setState("forbidden");
      } else if (result.outcome === "error") {
        setState("error");
      } else {
        setOrders(result.orders);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  async function handleAdvance(order: StoreOrderSummary) {
    const outcome = await advanceStoreOrderStatusFromBrowser(
      order.orderId,
      locationId,
      order.status,
    );

    if (outcome.outcome === "forbidden") {
      setState("forbidden");
      return;
    }
    if (outcome.outcome === "conflict") {
      // Someone else already acted — resync rather than guess.
      setNotice(outcome.message);
      await load();
      return;
    }
    if (outcome.outcome === "error") {
      setNotice(outcome.message);
      return;
    }

    const nextStatus = outcome.result.status;
    setOrders((current) => {
      if (!current) return current;
      if (!isActiveOrderStatus(nextStatus)) {
        return current.filter((o) => o.orderId !== order.orderId);
      }
      return current.map((o) =>
        o.orderId === order.orderId ? { ...o, status: nextStatus } : o,
      );
    });
  }

  const header = (
    <AdminPageHeader
      title="Orders"
      description="Work the live queue for this location."
      context={{ label: locationName, kind: "location" }}
      actions={
        state === "ok" ? (
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        ) : undefined
      }
    />
  );

  if (state === "forbidden") {
    return (
      <AdminPage>
        {header}
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (state === "error") {
    return (
      <AdminPage>
        {header}
        <AdminErrorState
          description="Couldn't load the order queue for this location."
          onRetry={() => void load()}
        />
      </AdminPage>
    );
  }

  return (
    <AdminPage>
      {header}

      {notice ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          {notice}
        </Card>
      ) : null}

      {orders === null ? (
        <AdminLoading label="Loading orders" />
      ) : orders.length === 0 ? (
        <AdminEmptyState
          title="No active orders"
          description="Nothing is in the queue for this location right now."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {orders.map((order) => (
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
    </AdminPage>
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
          </span>
        </div>
        <OrderStatusBadge status={order.status} />
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
          <Button onClick={handleClick} disabled={advancing}>
            {advancing ? "Updating…" : nextActionLabel}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
