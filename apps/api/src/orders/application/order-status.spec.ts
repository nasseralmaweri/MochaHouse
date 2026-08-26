import { isActiveOrderStatus, nextOrderStatus } from '@mocha-house/domain';

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
