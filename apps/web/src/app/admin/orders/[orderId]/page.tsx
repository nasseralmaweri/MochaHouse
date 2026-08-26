"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import type { OrderStatus, StoreOrderDetail } from "@mocha-house/contracts";
import {
  advanceStoreOrderStatusFromBrowser,
  getStoreOrderDetailFromBrowser,
} from "@/lib/api-client";
import { formatPrice } from "@/lib/money";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";

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

// DEV-ONLY / INTERNAL: see AdminOrdersController — no staff authentication
// exists yet.
export default function AdminOrderDetailPage() {
  const params = useParams<{ orderId: string }>();
  const searchParams = useSearchParams();
  const locationId = searchParams.get("location");

  const [order, setOrder] = useState<StoreOrderDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);

  const load = useCallback(() => {
    if (!locationId) return;
    getStoreOrderDetailFromBrowser(params.orderId, locationId)
      .then((result) => {
        if (result === null) {
          setNotFound(true);
          return;
        }
        setOrder(result);
      })
      .catch(() => setLoadError("Could not load this order."));
  }, [params.orderId, locationId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAdvance() {
    if (!order || !locationId) return;
    setAdvancing(true);
    setActionError(null);
    try {
      const outcome = await advanceStoreOrderStatusFromBrowser(
        order.orderId,
        locationId,
        order.status,
      );
      if (outcome.outcome === "conflict") {
        setActionError(outcome.message);
        load();
        return;
      }
      if (outcome.outcome === "error") {
        setActionError(outcome.message);
        return;
      }
      setOrder({ ...order, status: outcome.result.status });
    } finally {
      setAdvancing(false);
    }
  }

  const backHref = locationId
    ? `/admin/orders?location=${locationId}`
    : "/admin/orders";

  if (!locationId) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader title="No location selected" />
        <BackLink href="/admin/orders">Choose a location</BackLink>
      </main>
    );
  }

  if (notFound) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader title="Order not found" subtitle="It may belong to a different location." />
        <BackLink href={backHref}>Back to orders</BackLink>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader title="Couldn't load this order" subtitle={loadError} />
        <BackLink href={backHref}>Back to orders</BackLink>
      </main>
    );
  }

  if (!order) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader title="Loading order…" />
      </main>
    );
  }

  const nextActionLabel = NEXT_ACTION_LABEL[order.status];

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title={`Order #${order.orderNumber}`}
        subtitle={`Status: ${STATUS_LABEL[order.status]}`}
      />

      <Card className="flex flex-col gap-1 text-sm">
        <span className="text-text-primary">{order.guestName}</span>
        <span className="text-text-secondary">{order.guestPhone}</span>
      </Card>

      <Card className="flex flex-col gap-2">
        <ul className="flex flex-col gap-2">
          {order.lines.map((line, index) => (
            <li key={index} className="flex items-start justify-between gap-4 text-sm">
              <span className="text-text-primary">
                {line.quantity}× {line.productName}
                {line.selections.length > 0 ? (
                  <span className="block text-xs text-text-muted">
                    {line.selections.map((s) => s.optionNames.join(", ")).join(" · ")}
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

      {actionError ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          {actionError}
        </Card>
      ) : null}

      {nextActionLabel ? (
        <button
          type="button"
          onClick={handleAdvance}
          disabled={advancing}
          className="flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-4 py-3 text-base font-semibold text-status-success disabled:bg-surface-subtle disabled:text-text-muted"
        >
          {advancing ? "Updating…" : nextActionLabel}
        </button>
      ) : (
        <p className="text-center text-sm text-text-muted">This order is complete.</p>
      )}

      <BackLink href={backHref}>Back to orders</BackLink>
    </main>
  );
}
