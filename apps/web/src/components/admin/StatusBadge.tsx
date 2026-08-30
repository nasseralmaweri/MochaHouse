import type { OrderStatus } from "@mocha-house/contracts";

// A generic, presentational status pill. Label text is always shown (never
// colour-only) for accessibility. Kept deliberately small — this is the
// shared primitive for simple state (active/inactive, on/off) across Admin
// modules; the order-specific OrderStatusBadge below stays its own thing.
type BadgeTone = "neutral" | "positive" | "warning";

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: "bg-surface-subtle text-text-secondary",
  positive: "bg-status-success/10 text-status-success",
  warning: "bg-status-warning/10 text-status-warning",
};

export function StatusBadge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: BadgeTone;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium ${BADGE_TONE[tone]}`}
    >
      {label}
    </span>
  );
}

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
