import type { OrderStatus, OrderStatusResponse } from '@mocha-house/contracts';
import type { ConnectionState } from '@/lib/polling/polling-controller';
import {
  TRACKING_POLL,
  describeTrackingConnection,
  TRACKING_STATUS_LABEL,
  isClosedWithoutFulfilment,
  isTrackingFinal,
  statusChangeAnnouncement,
  statusHeadline,
  trackingDocumentTitle,
} from './order-tracking';

const order = (status: OrderStatus) => ({ status }) as OrderStatusResponse;

describe('isTrackingFinal', () => {
  it('stops polling once the order is completed, rejected or cancelled', () => {
    for (const status of ['RECEIVED', 'ACCEPTED', 'PREPARING', 'READY'] as const) {
      expect(isTrackingFinal(order(status))).toBe(false);
    }
    for (const status of ['COMPLETED', 'REJECTED', 'CANCELLED'] as const) {
      expect(isTrackingFinal(order(status))).toBe(true);
    }
  });
});

describe('rejected and cancelled orders (R1 / S5a)', () => {
  const all: OrderStatus[] = ['RECEIVED', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED', 'REJECTED', 'CANCELLED'];

  it('have a plain label and headline for every status, never a raw enum value', () => {
    for (const status of all) {
      expect(TRACKING_STATUS_LABEL[status]).toMatch(/^[A-Z][a-z ]+$/);
      expect(statusHeadline(status).length).toBeGreaterThan(0);
    }
    expect(statusHeadline('REJECTED')).toBe("The shop couldn't take your order");
    expect(statusHeadline('CANCELLED')).toBe('Your order was cancelled');
  });

  it('are closed without fulfilment; COMPLETED is not', () => {
    expect(isClosedWithoutFulfilment('REJECTED')).toBe(true);
    expect(isClosedWithoutFulfilment('CANCELLED')).toBe(true);
    for (const status of ['RECEIVED', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED'] as const) {
      expect(isClosedWithoutFulfilment(status)).toBe(false);
    }
  });

  it('never tell the customer a closed order is complete', () => {
    expect(describeTrackingConnection('complete', 'REJECTED').label).toBe('This order is closed');
    expect(describeTrackingConnection('complete', 'CANCELLED').label).toBe('This order is closed');
    expect(describeTrackingConnection('complete', 'COMPLETED').label).toBe('This order is complete');
    // Without a status (not yet loaded) the existing wording is unchanged.
    expect(describeTrackingConnection('complete').label).toBe('This order is complete');
  });

  it('announce the change when a live order is turned away', () => {
    expect(statusChangeAnnouncement('RECEIVED', 'REJECTED')).toBe(statusHeadline('REJECTED'));
    expect(statusChangeAnnouncement('PREPARING', 'CANCELLED')).toBe('Your order was cancelled');
  });

  it('title the tab with the status', () => {
    expect(trackingDocumentTitle('D4PWM7', 'CANCELLED')).toBe('Order #D4PWM7 · Cancelled');
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
    'loading', 'failed', 'live', 'catching-up', 'degraded', 'stale', 'offline', 'forbidden', 'not-found', 'complete',
  ];

  it('has wording for every connection state', () => {
    for (const state of states) {
      expect(describeTrackingConnection(state).label.length).toBeGreaterThan(0);
    }
  });

  it('does not cry outage while a tab or device is simply catching up', () => {
    expect(describeTrackingConnection('catching-up')).toEqual(
      describeTrackingConnection('live'),
    );
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
