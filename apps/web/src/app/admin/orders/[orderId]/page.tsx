"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { OrderStatus, StoreOrderDetail } from "@mocha-house/contracts";
import {
  advanceStoreOrderStatusFromBrowser,
  getStoreOrderDetailFromBrowser,
} from "@/lib/api-client";
import { formatPrice } from "@/lib/money";
import { Card } from "@/components/Card";
import { BackLink } from "@/components/BackLink";
import { AdminPage } from "@/components/admin/AdminPage";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import {
  AdminErrorState,
  AdminForbidden,
  AdminLoading,
  AdminNotFound,
} from "@/components/admin/states";
import { Button } from "@/components/admin/Button";
import { ORDER_STATUS_LABEL } from "@/components/admin/StatusBadge";
import { useAdminContext } from "@/components/admin/AdminContext";

const NEXT_ACTION_LABEL: Record<OrderStatus, string | null> = {
  RECEIVED: "Accept",
  ACCEPTED: "Start preparing",
  PREPARING: "Mark ready",
  READY: "Complete",
  COMPLETED: null,
};

// Order detail, inside the shared Admin shell. Location comes from the
// shell's authorization-aware context. Advance / conflict behaviour
// unchanged from the predecessor.
export default function AdminOrderDetailPage() {
  const params = useParams<{ orderId: string }>();
  const { can, locationContext } = useAdminContext();

  if (!can("orders.view")) {
    return (
      <AdminPage>
        <AdminPageHeader title="Order" />
        <AdminForbidden />
      </AdminPage>
    );
  }

  if (
    locationContext.kind === "forbidden" ||
    locationContext.kind === "corporate" ||
    locationContext.kind === "none"
  ) {
    return (
      <AdminPage>
        <AdminPageHeader title="Order" />
        <AdminForbidden
          title="Pick a location first"
          description="Open this order from its location's queue so the right scope is applied."
        />
        <BackLink href="/admin/orders">Back to orders</BackLink>
      </AdminPage>
    );
  }

  return (
    <OrderDetail
      orderId={params.orderId}
      locationId={locationContext.location.id}
      locationName={locationContext.location.name}
    />
  );
}

function OrderDetail({
  orderId,
  locationId,
  locationName,
}: {
  orderId: string;
  locationId: string;
  locationName: string;
}) {
  const [order, setOrder] = useState<StoreOrderDetail | null>(null);
  const [state, setState] = useState<
    "loading" | "ok" | "not-found" | "forbidden" | "error"
  >("loading");
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);

  // Fetch + apply. Does NOT touch `state` to "loading" itself — the initial
  // state is already "loading", and the retry button sets it explicitly.
  const load = useCallback(async () => {
    const result = await getStoreOrderDetailFromBrowser(orderId, locationId);
    if (result.outcome === "success") {
      setOrder(result.order);
      setState("ok");
    } else if (result.outcome === "not-found") {
      setState("not-found");
    } else if (result.outcome === "forbidden") {
      setState("forbidden");
    } else {
      setState("error");
    }
  }, [orderId, locationId]);

  useEffect(() => {
    let cancelled = false;
    getStoreOrderDetailFromBrowser(orderId, locationId).then((result) => {
      if (cancelled) return;
      if (result.outcome === "success") {
        setOrder(result.order);
        setState("ok");
      } else if (result.outcome === "not-found") {
        setState("not-found");
      } else if (result.outcome === "forbidden") {
        setState("forbidden");
      } else {
        setState("error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [orderId, locationId]);

  const retry = () => {
    setState("loading");
    void load();
  };

  async function handleAdvance() {
    if (!order) return;
    setAdvancing(true);
    setActionNotice(null);
    try {
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
        setActionNotice(outcome.message);
        await load();
        return;
      }
      if (outcome.outcome === "error") {
        setActionNotice(outcome.message);
        return;
      }
      setOrder({ ...order, status: outcome.result.status });
    } finally {
      setAdvancing(false);
    }
  }

  const backHref = `/admin/orders?location=${encodeURIComponent(locationId)}`;

  if (state === "loading") {
    return (
      <AdminPage>
        <AdminPageHeader title="Order" />
        <AdminLoading label="Loading order" />
      </AdminPage>
    );
  }
  if (state === "not-found") {
    return (
      <AdminPage>
        <AdminPageHeader title="Order not found" />
        <AdminNotFound
          description="This order doesn't exist for this location."
          backHref={backHref}
          backLabel="Back to orders"
        />
      </AdminPage>
    );
  }
  if (state === "forbidden") {
    return (
      <AdminPage>
        <AdminPageHeader title="Order" />
        <AdminForbidden />
      </AdminPage>
    );
  }
  if (state === "error" || !order) {
    return (
      <AdminPage>
        <AdminPageHeader title="Order" />
        <AdminErrorState description="Couldn't load this order." onRetry={retry} />
        <BackLink href={backHref}>Back to orders</BackLink>
      </AdminPage>
    );
  }

  const nextActionLabel = NEXT_ACTION_LABEL[order.status];

  return (
    <AdminPage>
      <AdminPageHeader
        title={`Order #${order.orderNumber}`}
        description={`Status: ${ORDER_STATUS_LABEL[order.status]}`}
        context={{ label: locationName, kind: "location" }}
        breadcrumbs={[
          { label: "Orders", href: backHref },
          { label: `#${order.orderNumber}` },
        ]}
      />

      <Card className="flex flex-col gap-1 text-sm">
        <span className="text-text-primary">{order.guestName}</span>
        <span className="text-text-secondary">{order.guestPhone}</span>
      </Card>

      <Card className="flex flex-col gap-2">
        <ul className="flex flex-col gap-2">
          {order.lines.map((line, index) => (
            <li
              key={index}
              className="flex items-start justify-between gap-4 text-sm"
            >
              <span className="text-text-primary">
                {line.quantity}× {line.productName}
                {line.selections.length > 0 ? (
                  <span className="block text-xs text-text-muted">
                    {line.selections
                      .map((s) => s.optionNames.join(", "))
                      .join(" · ")}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-text-secondary">
                {formatPrice(line.lineTotal, line.currency)}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t border-border-default pt-2">
          <span className="text-sm font-semibold text-text-primary">Total</span>
          <span className="text-lg font-semibold text-text-primary">
            {formatPrice(order.subtotal, order.currency)}
          </span>
        </div>
      </Card>

      {actionNotice ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          {actionNotice}
        </Card>
      ) : null}

      {nextActionLabel ? (
        <Button onClick={handleAdvance} disabled={advancing}>
          {advancing ? "Updating…" : nextActionLabel}
        </Button>
      ) : (
        <p className="text-sm text-text-muted">This order is complete.</p>
      )}

      <BackLink href={backHref}>Back to orders</BackLink>
    </AdminPage>
  );
}
