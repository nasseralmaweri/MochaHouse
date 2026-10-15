import {
  ACTIVE_ORDER_STATUSES,
  ALL_ORDER_STATUSES,
  NON_SALE_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
  isCommercialSaleOrderStatus,
  isActiveOrderStatus,
  isTerminalOrderStatus,
  nextOrderStatus,
} from '@mocha-house/domain';

describe('nextOrderStatus', () => {
  it('advances through the approved pipeline one step at a time', () => {
    expect(nextOrderStatus('RECEIVED')).toBe('ACCEPTED');
    expect(nextOrderStatus('ACCEPTED')).toBe('PREPARING');
    expect(nextOrderStatus('PREPARING')).toBe('READY');
    expect(nextOrderStatus('READY')).toBe('COMPLETED');
  });

  it('has no next status once COMPLETED', () => {
    expect(nextOrderStatus('COMPLETED')).toBeNull();
  });

  it('can never advance into, or out of, REJECTED or CANCELLED', () => {
    expect(nextOrderStatus('REJECTED')).toBeNull();
    expect(nextOrderStatus('CANCELLED')).toBeNull();
    for (const status of ALL_ORDER_STATUSES) {
      expect(nextOrderStatus(status)).not.toBe('REJECTED');
      expect(nextOrderStatus(status)).not.toBe('CANCELLED');
    }
  });
});

describe('isActiveOrderStatus', () => {
  it('is true for every in-progress status, false for every terminal one', () => {
    expect(isActiveOrderStatus('RECEIVED')).toBe(true);
    expect(isActiveOrderStatus('ACCEPTED')).toBe(true);
    expect(isActiveOrderStatus('PREPARING')).toBe(true);
    expect(isActiveOrderStatus('READY')).toBe(true);
    expect(isActiveOrderStatus('COMPLETED')).toBe(false);
    expect(isActiveOrderStatus('REJECTED')).toBe(false);
    expect(isActiveOrderStatus('CANCELLED')).toBe(false);
  });
});

describe('active and terminal status classification', () => {
  it('classifies every status as exactly one of active or terminal', () => {
    for (const status of [
      ...ACTIVE_ORDER_STATUSES,
      ...TERMINAL_ORDER_STATUSES,
    ]) {
      expect(isActiveOrderStatus(status)).toBe(!isTerminalOrderStatus(status));
    }
    expect(
      [...ACTIVE_ORDER_STATUSES, ...TERMINAL_ORDER_STATUSES].sort(),
    ).toEqual([
      'ACCEPTED',
      'CANCELLED',
      'COMPLETED',
      'PREPARING',
      'READY',
      'RECEIVED',
      'REJECTED',
    ]);
    expect([...ALL_ORDER_STATUSES].sort()).toEqual(
      [...ACTIVE_ORDER_STATUSES, ...TERMINAL_ORDER_STATUSES].sort(),
    );
  });

  it('COMPLETED, REJECTED and CANCELLED are terminal and none is queue work', () => {
    expect([...TERMINAL_ORDER_STATUSES]).toEqual([
      'COMPLETED',
      'REJECTED',
      'CANCELLED',
    ]);
    for (const status of TERMINAL_ORDER_STATUSES) {
      expect(isTerminalOrderStatus(status)).toBe(true);
      expect(isActiveOrderStatus(status)).toBe(false);
    }
    expect(isActiveOrderStatus('READY')).toBe(true);
  });
});

describe('commercial-sale classification', () => {
  it('counts every in-progress and completed order as a sale, never a rejected or cancelled one', () => {
    for (const status of [
      'RECEIVED',
      'ACCEPTED',
      'PREPARING',
      'READY',
      'COMPLETED',
    ] as const) {
      expect(isCommercialSaleOrderStatus(status)).toBe(true);
    }
    expect(isCommercialSaleOrderStatus('REJECTED')).toBe(false);
    expect(isCommercialSaleOrderStatus('CANCELLED')).toBe(false);
    expect([...NON_SALE_ORDER_STATUSES].sort()).toEqual([
      'CANCELLED',
      'REJECTED',
    ]);
  });
});
