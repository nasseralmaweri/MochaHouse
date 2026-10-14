import {
  ACTIVE_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
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
});

describe('isActiveOrderStatus', () => {
  it('is true for every status except COMPLETED', () => {
    expect(isActiveOrderStatus('RECEIVED')).toBe(true);
    expect(isActiveOrderStatus('ACCEPTED')).toBe(true);
    expect(isActiveOrderStatus('PREPARING')).toBe(true);
    expect(isActiveOrderStatus('READY')).toBe(true);
    expect(isActiveOrderStatus('COMPLETED')).toBe(false);
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
    ).toEqual(['ACCEPTED', 'COMPLETED', 'PREPARING', 'READY', 'RECEIVED']);
  });

  it('only COMPLETED is terminal today, and it is not queue work', () => {
    expect([...TERMINAL_ORDER_STATUSES]).toEqual(['COMPLETED']);
    expect(isTerminalOrderStatus('COMPLETED')).toBe(true);
    expect(isActiveOrderStatus('READY')).toBe(true);
  });
});
