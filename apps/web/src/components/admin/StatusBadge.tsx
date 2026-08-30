import type { OrderStatus } from "@mocha-house/contracts";

const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  RECEIVED: "Received",
  ACCEPTED: "Accepted",
  PREPARING: "Preparing",
  READY: "Ready",
  COMPLETED: "Completed",
};

// A small status pill. The label text is always present (not colour-only)
// for accessibility. Dedupes the inline span + STATUS_LABEL map the two
// Admin order screens each declared.
export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-surface-subtle px-2.5 py-1 text-xs font-medium text-text-secondary">
      {ORDER_STATUS_LABEL[status]}
    </span>
  );
}

export { ORDER_STATUS_LABEL };
