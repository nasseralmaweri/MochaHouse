"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import type { OrderStatus, OrderStatusResponse } from "@mocha-house/contracts";
import { getOrderStatusFromBrowser } from "@/lib/api-client";
import { formatPrice } from "@/lib/money";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";

const STATUS_LABEL: Record<OrderStatus, string> = {
  RECEIVED: "Received",
  ACCEPTED: "Accepted",
  PREPARING: "Preparing",
  READY: "Ready for pickup",
  COMPLETED: "Completed",
};

// The URL (orderId + accessToken) is the only source of truth here — this
// page never reads the cart or any client-side session state, so a reload,
// a bookmark, or navigating away and back all resolve the same way: refetch
// from the backend and render whatever it says right now.
export default function OrderConfirmationPage() {
  const params = useParams<{ orderId: string }>();
  const searchParams = useSearchParams();
  const accessToken = searchParams.get("token") ?? "";

  const [status, setStatus] = useState<OrderStatusResponse | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    getOrderStatusFromBrowser(params.orderId, accessToken)
      .then((result) => {
        if (cancelled) return;
        if (result === null) {
          setNotFound(true);
          return;
        }
        setStatus(result);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [params.orderId, accessToken]);

  if (notFound) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader
          title="Order not found"
          subtitle="This confirmation link is invalid, or the access token doesn't match."
        />
        <BackLink href="/order/location">Start a new order</BackLink>
      </main>
    );
  }

  if (loadFailed) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader
          title="Couldn't load your order"
          subtitle="Please check your connection and try reloading this page."
        />
        <BackLink href="/order/location">Start a new order</BackLink>
      </main>
    );
  }

  if (!status) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader title="Loading your order…" />
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Order confirmed"
        subtitle={`Order #${status.orderNumber} · ${status.locationName}`}
      />

      <Card className="flex flex-col gap-2">
        <ul className="flex flex-col gap-2">
          {status.lines.map((line, index) => (
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
            {formatPrice(status.subtotal, status.currency)}
          </span>
        </div>
      </Card>

      <Card tone="subtle" className="flex flex-col gap-1 text-sm text-text-secondary">
        <span>Thanks, {status.guestName}!</span>
        <span>Status: {STATUS_LABEL[status.status]}</span>
      </Card>

      <BackLink href="/order/location">Start a new order</BackLink>
    </main>
  );
}
