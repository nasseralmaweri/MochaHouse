import type { OrderStatus, StoreOrderSummary } from '@mocha-house/contracts';
import {
  applyAdvanced,
  arrivalAnnouncement,
  countAwaitingAcceptance,
  describeConnection,
  findArrivals,
  groupOrders,
  orderAgeLabel,
  queueTitle,
} from './order-queue';

function order(
  id: string,
  status: OrderStatus,
  createdAt = '2026-10-14T12:00:00.000Z',
): StoreOrderSummary {
  return {
    orderId: id,
    orderNumber: `N-${id}`,
    status,
    createdAt,
    guestName: 'Guest',
    subtotal: 500,
    currency: 'USD',
    lines: [],
  };
}

describe('groupOrders', () => {
  it('groups by phase, oldest first, with a stable tiebreak', () => {
    const groups = groupOrders([
      order('b', 'RECEIVED', '2026-10-14T12:05:00.000Z'),
      order('a', 'RECEIVED', '2026-10-14T12:01:00.000Z'),
      order('d', 'PREPARING', '2026-10-14T12:00:00.000Z'),
      order('c', 'ACCEPTED', '2026-10-14T12:00:00.000Z'),
      order('e', 'READY'),
    ]);
    expect(groups.needsAcceptance.map((o) => o.orderId)).toEqual(['a', 'b']);
    expect(groups.inProgress.map((o) => o.orderId)).toEqual(['c', 'd']);
    expect(groups.ready.map((o) => o.orderId)).toEqual(['e']);
  });

  it('leaves out orders that are not queue work', () => {
    const groups = groupOrders([order('x', 'COMPLETED')]);
    expect([
      ...groups.needsAcceptance,
      ...groups.inProgress,
      ...groups.ready,
    ]).toEqual([]);
  });
});

describe('findArrivals', () => {
  it('announces nothing on the first load, however many orders are waiting', () => {
    expect(findArrivals(null, [order('a', 'RECEIVED'), order('b', 'RECEIVED')])).toEqual([]);
  });

  it('reports only RECEIVED orders not seen before', () => {
    const known = new Set(['a']);
    expect(
      findArrivals(known, [
        order('a', 'RECEIVED'),
        order('b', 'RECEIVED'),
        order('c', 'PREPARING'),
      ]),
    ).toEqual(['b']);
  });

  it('does not report an order again once it is known', () => {
    expect(findArrivals(new Set(['a', 'b']), [order('a', 'RECEIVED'), order('b', 'RECEIVED')])).toEqual([]);
  });
});

describe('applyAdvanced', () => {
  const list = [order('a', 'RECEIVED'), order('b', 'READY')];

  it('updates the status of the advanced order only, without mutating the input', () => {
    const next = applyAdvanced(list, 'a', 'ACCEPTED');
    expect(next.map((o) => o.status)).toEqual(['ACCEPTED', 'READY']);
    expect(list[0].status).toBe('RECEIVED');
  });

  it('removes an order that leaves the active pipeline', () => {
    expect(applyAdvanced(list, 'b', 'COMPLETED').map((o) => o.orderId)).toEqual(['a']);
  });

  it('ignores an unknown order id', () => {
    expect(applyAdvanced(list, 'zzz', 'ACCEPTED')).toEqual(list);
  });
});

describe('countAwaitingAcceptance and queueTitle', () => {
  it('counts RECEIVED orders and puts the count in the title', () => {
    expect(
      countAwaitingAcceptance([order('a', 'RECEIVED'), order('b', 'RECEIVED'), order('c', 'READY')]),
    ).toBe(2);
    expect(queueTitle(2)).toBe('(2) Orders');
    expect(queueTitle(0)).toBe('Orders');
  });
});

describe('orderAgeLabel', () => {
  const created = '2026-10-14T12:00:00.000Z';
  const at = (minutes: number) => Date.parse(created) + minutes * 60_000;
  it('formats minutes and hours', () => {
    expect(orderAgeLabel(created, at(0))).toBe('just now');
    expect(orderAgeLabel(created, at(7))).toBe('7 min');
    expect(orderAgeLabel(created, at(60))).toBe('1 h');
    expect(orderAgeLabel(created, at(65))).toBe('1 h 5 min');
  });
  it('never goes negative and tolerates a bad date', () => {
    expect(orderAgeLabel(created, at(-5))).toBe('just now');
    expect(orderAgeLabel('not-a-date', 0)).toBe('');
  });
});

describe('arrivalAnnouncement', () => {
  it('words singular and plural, and is empty for none', () => {
    expect(arrivalAnnouncement(0)).toBe('');
    expect(arrivalAnnouncement(1)).toBe('1 new order');
    expect(arrivalAnnouncement(3)).toBe('3 new orders');
  });
});

describe('describeConnection', () => {
  it('allows actions only while live or recovering with fresh data', () => {
    expect(describeConnection('live').actionsPausedReason).toBeNull();
    expect(describeConnection('degraded').actionsPausedReason).toBeNull();
    for (const state of ['catching-up', 'stale', 'offline', 'forbidden', 'failed', 'loading', 'not-found'] as const) {
      expect(describeConnection(state).actionsPausedReason).not.toBeNull();
    }
  });

  it('never presents out-of-date data as live', () => {
    expect(describeConnection('catching-up').label).toBe('Updating…');
    expect(describeConnection('catching-up').label).not.toMatch(/lost|offline/i);
    expect(describeConnection('stale').label).toMatch(/out of date/);
    expect(describeConnection('offline').label).toMatch(/out of date/);
    expect(describeConnection('live').tone).toBe('ok');
  });
});
