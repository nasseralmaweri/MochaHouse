import type { OrderStatus, StoreOrderSummary } from '@mocha-house/contracts';
import { isActiveOrderStatus } from '@mocha-house/domain';
import type { ConnectionState } from '@/lib/polling/polling-controller';

// Pure helpers for the live staff order queue (R1 / S2a). Nothing here knows
// about tenants or locations — the list it receives is already scoped to one
// location by the server — and nothing is specific to any one business.

export interface QueueGroups {
  // RECEIVED: the shop has not acknowledged the order yet.
  readonly needsAcceptance: StoreOrderSummary[];
  // ACCEPTED and PREPARING.
  readonly inProgress: StoreOrderSummary[];
  // READY: waiting for the customer.
  readonly ready: StoreOrderSummary[];
}

function byAge(a: StoreOrderSummary, b: StoreOrderSummary): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0;
}

// Oldest first inside each group, so the order that has waited longest is
// always at the top. Orders in any other status are not queue work and are
// left out rather than shown in a wrong group.
export function groupOrders(orders: readonly StoreOrderSummary[]): QueueGroups {
  const pick = (...statuses: OrderStatus[]) =>
    orders.filter((o) => statuses.includes(o.status)).sort(byAge);
  return {
    needsAcceptance: pick('RECEIVED'),
    inProgress: pick('ACCEPTED', 'PREPARING'),
    ready: pick('READY'),
  };
}

// The ids of orders that are new to this screen: RECEIVED, and not in
// `knownIds`. `knownIds === null` is the very first load — everything already
// waiting is not an "arrival", so opening the page never announces the backlog.
export function findArrivals(
  knownIds: ReadonlySet<string> | null,
  orders: readonly StoreOrderSummary[],
): string[] {
  if (knownIds === null) return [];
  return orders
    .filter((o) => o.status === 'RECEIVED' && !knownIds.has(o.orderId))
    .map((o) => o.orderId);
}

export function countAwaitingAcceptance(
  orders: readonly StoreOrderSummary[],
): number {
  return orders.filter((o) => o.status === 'RECEIVED').length;
}

// Reflect a status change the server has just confirmed. A change that leaves
// the active pipeline removes the card. Pure: returns a new array.
export function applyAdvanced(
  orders: readonly StoreOrderSummary[],
  orderId: string,
  newStatus: OrderStatus,
): StoreOrderSummary[] {
  if (!isActiveOrderStatus(newStatus)) {
    return orders.filter((o) => o.orderId !== orderId);
  }
  return orders.map((o) =>
    o.orderId === orderId ? { ...o, status: newStatus } : o,
  );
}

// "just now", "7 min", "1 h 5 min". Never negative (clock skew).
export function orderAgeLabel(createdAtIso: string, nowMs: number): string {
  const created = Date.parse(createdAtIso);
  if (Number.isNaN(created)) return '';
  const minutes = Math.max(0, Math.floor((nowMs - created) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function arrivalAnnouncement(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? '1 new order' : `${count} new orders`;
}

export function queueTitle(awaitingAcceptance: number): string {
  return awaitingAcceptance > 0
    ? `(${awaitingAcceptance}) Orders`
    : 'Orders';
}

export interface ConnectionNotice {
  // Short state text; announced politely when the state changes.
  readonly label: string;
  readonly tone: 'ok' | 'warning' | 'danger';
  // Why status buttons are paused, or null when they are available.
  readonly actionsPausedReason: string | null;
}

export function describeConnection(
  connection: ConnectionState,
): ConnectionNotice {
  switch (connection) {
    case 'live':
      return { label: 'Live', tone: 'ok', actionsPausedReason: null };
    case 'degraded':
      return {
        label: 'Reconnecting… showing the last update',
        tone: 'warning',
        actionsPausedReason: null,
      };
    case 'stale':
      return {
        label: 'Connection lost — this list may be out of date',
        tone: 'danger',
        actionsPausedReason:
          'Order actions are paused until the list refreshes.',
      };
    case 'offline':
      return {
        label: 'Offline — this list may be out of date',
        tone: 'danger',
        actionsPausedReason:
          'Order actions are paused while this device is offline.',
      };
    case 'forbidden':
      return {
        label: 'Not permitted',
        tone: 'danger',
        actionsPausedReason: 'You do not have access to this queue.',
      };
    case 'failed':
      return {
        label: 'Could not load orders',
        tone: 'danger',
        actionsPausedReason: 'Orders have not loaded.',
      };
    case 'not-found':
      return {
        label: 'Not found',
        tone: 'danger',
        actionsPausedReason: 'This queue could not be found.',
      };
    case 'complete':
      return { label: 'Complete', tone: 'ok', actionsPausedReason: null };
    case 'loading':
    default:
      return {
        label: 'Loading orders…',
        tone: 'warning',
        actionsPausedReason: 'Orders have not loaded.',
      };
  }
}
