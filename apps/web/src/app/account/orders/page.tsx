import Link from "next/link";
import { redirect } from "next/navigation";
import type { OrderStatus } from "@mocha-house/contracts";
import { getCustomerSessionToken } from "@/lib/auth/session";
import { getCustomerOrders } from "@/lib/auth/orders";
import { formatPrice } from "@/lib/money";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";

const STATUS_LABEL: Record<OrderStatus, string> = {
  RECEIVED: "Received",
  ACCEPTED: "Accepted",
  PREPARING: "Preparing",
  READY: "Ready",
  COMPLETED: "Completed",
};

export default async function AccountOrdersPage() {
  const token = await getCustomerSessionToken();
  if (!token) {
    redirect("/account/sign-in");
  }

  const result = await getCustomerOrders(token);
  if (result.outcome === "unauthorized") {
    redirect("/account/sign-in");
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader title="My orders" />

      {result.outcome === "error" ? (
        <Card tone="subtle" className="text-sm text-status-warning">
          We couldn&apos;t load your orders. Please try again later.
        </Card>
      ) : result.orders.length === 0 ? (
        <p className="text-sm text-text-muted">
          You haven&apos;t placed any orders yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {result.orders.map((order) => (
            <li key={order.orderId}>
              <Link
                href={`/account/orders/${order.orderId}`}
                className="block rounded-xl transition active:scale-[0.99] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <Card className="flex items-center justify-between gap-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-base font-semibold text-text-primary">
                      #{order.orderNumber}
                    </span>
                    <span className="text-sm text-text-secondary">
                      {order.locationName} ·{" "}
                      {new Date(order.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-sm font-medium text-text-primary">
                      {formatPrice(order.subtotal, order.currency)}
                    </span>
                    <span className="text-xs text-text-muted">
                      {STATUS_LABEL[order.status]}
                    </span>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <BackLink href="/account">Back to account</BackLink>
    </main>
  );
}
