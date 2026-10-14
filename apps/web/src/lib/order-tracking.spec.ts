import type { OrderStatus, OrderStatusResponse } from '@mocha-house/contracts';
import type { ConnectionState } from '@/lib/polling/polling-controller';
import {
  TRACKING_POLL,
  describeTrackingConnection,
  isTrackingFinal,
  statusChangeAnnouncement,
  statusHeadline,
  trackingDocumentTitle,
} from './order-tracking';

const order = (status: OrderStatus) => ({ status }) as OrderStatusResponse;

describe('isTrackingFinal', () => {
  it('stops polling only once the order is completed', () => {
    for (const status of ['RECEIVED', 'ACCEPTED', 'PREPARING', 'READY'] as const) {
      expect(isTrackingFinal(order(status))).toBe(false);
    }
    expect(isTrackingFinal(order('COMPLETED'))).toBe(true);
  });
});

describe('statusChangeAnnouncement', () => {
  it('says nothing on the first load or when the status is unchanged', () => {
    expect(statusChangeAnnouncement(null, 'RECEIVED')).toBeNull();
    expect(statusChangeAnnouncement('READY', 'READY')).toBeNull();
  });

  it('announces a change in plain words', () => {
    expect(statusChangeAnnouncement('PREPARING', 'READY')).toBe(
      'Your order is ready for pickup',
    );
    expect(statusChangeAnnouncement('RECEIVED', 'ACCEPTED')).toBe(
      statusHeadline('ACCEPTED'),
    );
  });
});

describe('trackingDocumentTitle', () => {
  it('carries only the order number and status', () => {
    expect(trackingDocumentTitle('D4PWM7', 'READY')).toBe('Order #D4PWM7 · Ready');
  });
});

describe('describeTrackingConnection', () => {
  const states: ConnectionState[] = [
    'loading', 'failed', 'live', 'degraded', 'stale', 'offline', 'forbidden', 'not-found', 'complete',
  ];

  it('has wording for every connection state', () => {
    for (const state of states) {
      expect(describeTrackingConnection(state).label.length).toBeGreaterThan(0);
    }
  });

  it('never presents an out-of-date status as current', () => {
    expect(describeTrackingConnection('stale').label).toMatch(/out of date/);
    expect(describeTrackingConnection('offline').label).toMatch(/out of date/);
    expect(describeTrackingConnection('stale').tone).toBe('danger');
    expect(describeTrackingConnection('live').tone).toBe('ok');
  });
});

describe('TRACKING_POLL', () => {
  it('is gentler than the staff queue and keeps a background tab slower still', () => {
    expect(TRACKING_POLL.intervalMs).toBeGreaterThanOrEqual(10_000);
    expect(TRACKING_POLL.hiddenIntervalMs).toBeGreaterThan(TRACKING_POLL.intervalMs);
    expect(TRACKING_POLL.staleAfterMs).toBeGreaterThan(TRACKING_POLL.intervalMs);
  });
});
