import type {
  OrderStatus,
  OrderStatusResponse,
} from '@mocha-house/contracts';
import { isTerminalOrderStatus } from '@mocha-house/domain';
import type { ConnectionState } from '@/lib/polling/polling-controller';

// Pure helpers for the customer's live order-tracking page (R1 / S2b). No
// tenant, brand or location is baked in: every name shown comes from the order
// the server returned.

// Customers are not staff: a gentler cadence, a longer staleness allowance and
// a slower background poll keep traffic low across many open tabs.
export const TRACKING_POLL = {
  intervalMs: 15_000,
  hiddenIntervalMs: 60_000,
  staleAfterMs: 45_000,
  maxBackoffMs: 60_000,
} as const;

// A completed order cannot change again, so polling stops.
export function isTrackingFinal(order: OrderStatusResponse): boolean {
  return isTerminalOrderStatus(order.status);
}

export const TRACKING_STATUS_LABEL: Record<OrderStatus, string> = {
  RECEIVED: 'Received',
  ACCEPTED: 'Accepted',
  PREPARING: 'Preparing',
  READY: 'Ready',
  COMPLETED: 'Completed',
};

const HEADLINE: Record<OrderStatus, string> = {
  RECEIVED: 'We have your order',
  ACCEPTED: 'The shop has accepted your order',
  PREPARING: 'Your order is being prepared',
  READY: 'Your order is ready for pickup',
  COMPLETED: 'Your order is complete',
};

export function statusHeadline(status: OrderStatus): string {
  return HEADLINE[status];
}

// What to say aloud when the status changes while the page is open. Nothing
// on the first load (the page already shows the status) or when it is
// unchanged.
export function statusChangeAnnouncement(
  previous: OrderStatus | null,
  next: OrderStatus,
): string | null {
  if (previous === null || previous === next) return null;
  return HEADLINE[next];
}

export function trackingDocumentTitle(
  orderNumber: string,
  status: OrderStatus,
): string {
  return `Order #${orderNumber} · ${TRACKING_STATUS_LABEL[status]}`;
}

export interface TrackingConnectionNotice {
  readonly label: string;
  readonly tone: 'ok' | 'warning' | 'danger';
}

// Customer-facing wording for each connection state. "Out of date" is always
// said plainly, so a stale status is never read as current.
export function describeTrackingConnection(
  connection: ConnectionState,
): TrackingConnectionNotice {
  switch (connection) {
    case 'live':
    // A background tab or a slept device that is simply due a refresh is not
    // an outage: say nothing alarming while it catches up.
    case 'catching-up':
      return { label: 'Updating automatically', tone: 'ok' };
    case 'complete':
      return { label: 'This order is complete', tone: 'ok' };
    case 'degraded':
      return {
        label: 'Reconnecting… showing the latest status we have',
        tone: 'warning',
      };
    case 'stale':
      return {
        label: "We can't reach the shop right now. This status may be out of date.",
        tone: 'danger',
      };
    case 'offline':
      return {
        label: "You're offline. This status may be out of date.",
        tone: 'danger',
      };
    case 'failed':
      return { label: "Couldn't load your order", tone: 'danger' };
    case 'not-found':
    case 'forbidden':
      return { label: 'Order not found', tone: 'danger' };
    case 'loading':
    default:
      return { label: 'Checking your order…', tone: 'warning' };
  }
}
