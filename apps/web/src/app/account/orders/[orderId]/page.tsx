import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { OrderStatus } from "@mocha-house/contracts";
import { getCustomerSessionToken } from "@/lib/auth/session";
import { getCustomerOrderDetail } from "@/lib/auth/orders";
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

export default async function AccountOrderDetailPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;

  const token = await getCustomerSessionToken();
  if (!token) {
    redirect("/account/sign-in");
  }

  const result = await getCustomerOrderDetail(token, orderId);

  if (result.outcome === "unauthorized") {
    redirect("/account/sign-in");
  }
  // "not found" also covers an order that belongs to another customer —
  // the API deliberately never distinguishes the two (see
  // CustomerOrdersService.getDetail), so neither does this page.
  if (result.outcome === "not-found") {
    notFound();
  }
  if (result.outcome === "error") {
    throw new Error("Failed to load order detail.");
  }

  const order = result.order;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title={`Order #${order.orderNumber}`}
        subtitle={`${order.locationName} · ${new Date(order.createdAt).toLocaleDateString()}`}
      />

      <Card className="flex flex-col gap-2">
        <ul className="flex flex-col gap-2">
          {order.lines.map((line, index) => (
            <li key={index} className="flex items-start justify-between gap-4 text-sm">
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
        <div className="flex flex-col gap-1 border-t border-border-default pt-2">
          {order.orderPromotion ||
          order.loyaltyReward ||
          order.orderGiftCard ? (
            <div className="flex items-center justify-between text-sm text-text-secondary">
              <span>Subtotal</span>
              <span>{formatPrice(order.subtotal, order.currency)}</span>
            </div>
          ) : null}
          {order.orderPromotion ? (
            <div className="flex items-center justify-between text-sm text-status-success">
              <span>
                {order.orderPromotion.kind === "COUPON" ? "Coupon" : "Promotion"}
                {" · "}
                {order.orderPromotion.name}
              </span>
              <span>
                −{formatPrice(order.promotionDiscount, order.currency)}
              </span>
            </div>
          ) : null}
          {order.loyaltyReward ? (
            <div className="flex items-center justify-between text-sm text-status-success">
              <span>Mocha Beans Reward · {order.loyaltyReward.rewardName}</span>
              <span>−{formatPrice(order.rewardDiscount, order.currency)}</span>
            </div>
          ) : null}
          <div className="flex items-center justify-between">
            <span
              className={`text-sm ${
                order.orderGiftCard
                  ? "text-text-secondary"
                  : "font-semibold text-text-primary"
              }`}
            >
              {order.orderGiftCard ? "Order total" : "Total"}
            </span>
            <span
              className={
                order.orderGiftCard
                  ? "text-sm text-text-secondary"
                  : "text-lg font-semibold text-text-primary"
              }
            >
              {formatPrice(order.total, order.currency)}
            </span>
          </div>
          {order.orderGiftCard ? (
            <>
              <div className="flex items-center justify-between text-sm text-status-success">
                <span>Gift Card •••• {order.orderGiftCard.last4}</span>
                <span>
                  −
                  {formatPrice(
                    order.orderGiftCard.amountMinorUnits,
                    order.currency,
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-text-primary">
                  Paid by card
                </span>
                <span className="text-lg font-semibold text-text-primary">
                  {formatPrice(order.externalPaymentMinorUnits, order.currency)}
                </span>
              </div>
            </>
          ) : null}
          {order.loyaltyReward ? (
            <p className="text-xs text-text-muted">
              {order.loyaltyReward.beanCost} Mocha Beans used
            </p>
          ) : null}
          {order.loyaltyBonus && order.loyaltyBonus.totalBonusBeans > 0 ? (
            <p className="text-xs text-status-success">
              +{order.loyaltyBonus.totalBonusBeans} bonus Mocha Beans earned
            </p>
          ) : null}
        </div>
      </Card>

      <Card tone="subtle" className="flex items-center justify-between text-sm text-text-secondary">
        <span>Status</span>
        <span className="text-text-primary">{STATUS_LABEL[order.status]}</span>
      </Card>

      <Link
        href={`/account/orders/${order.orderId}/reorder`}
        className="flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-4 py-3 text-base font-semibold text-status-success"
      >
        Reorder
      </Link>

      <BackLink href="/account/orders">Back to my orders</BackLink>
    </main>
  );
}
