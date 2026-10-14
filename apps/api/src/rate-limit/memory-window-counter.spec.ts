import { MemoryWindowCounter } from './memory-window-counter';

describe('MemoryWindowCounter', () => {
  let nowMs: number;
  const make = (maxKeys?: number) =>
    new MemoryWindowCounter(() => nowMs, maxKeys);

  beforeEach(() => {
    nowMs = 1_000_000;
  });

  it('counts within a window and reports the time left', () => {
    const counter = make();
    expect(counter.hit('k', 60, true)).toEqual({
      count: 1,
      retryAfterSeconds: 60,
    });
    nowMs += 10_000;
    expect(counter.hit('k', 60, true)).toEqual({
      count: 2,
      retryAfterSeconds: 50,
    });
  });

  it('starts a fresh window once the first one has ended', () => {
    const counter = make();
    counter.hit('k', 60, true);
    counter.hit('k', 60, true);
    nowMs += 60_001;
    expect(counter.hit('k', 60, true).count).toBe(1);
  });

  it('reads without counting when asked, and never creates an entry doing so', () => {
    const counter = make();
    expect(counter.hit('k', 60, false)).toEqual({
      count: 0,
      retryAfterSeconds: 60,
    });
    expect(counter.size).toBe(0);
    counter.hit('k', 60, true);
    expect(counter.hit('k', 60, false).count).toBe(1);
    expect(counter.hit('k', 60, false).count).toBe(1);
  });

  it('keeps keys independent', () => {
    const counter = make();
    counter.hit('a', 60, true);
    counter.hit('a', 60, true);
    expect(counter.hit('b', 60, true).count).toBe(1);
  });

  it('stays bounded under a flood of distinct keys', () => {
    const counter = make(100);
    for (let i = 0; i < 10_000; i += 1) counter.hit(`k${i}`, 60, true);
    expect(counter.size).toBeLessThanOrEqual(100);
  });

  it('drops expired entries before evicting live ones', () => {
    const counter = make(3);
    counter.hit('old1', 10, true);
    counter.hit('old2', 10, true);
    counter.hit('live', 600, true);
    nowMs += 11_000;
    counter.hit('new', 60, true);
    // The live key survived; the expired ones made the room.
    expect(counter.hit('live', 600, false).count).toBe(1);
    expect(counter.size).toBe(2);
  });

  it('refuses a NEW key when full of live counters, without evicting any live counter', () => {
    const counter = make(2);
    counter.hit('a', 60, true);
    counter.hit('a', 60, true);
    counter.hit('b', 60, true);
    const refused = counter.hit('flood', 60, true);
    expect(refused.count).toBe(Number.MAX_SAFE_INTEGER);
    expect(counter.size).toBe(2);
    // the existing counters were not reset by the flood
    expect(counter.hit('a', 60, false).count).toBe(2);
  });

  it('gives a count back, never below zero, and only for live entries', () => {
    const counter = make();
    counter.hit('k', 60, true);
    counter.hit('k', 60, true);
    counter.release('k');
    expect(counter.hit('k', 60, false).count).toBe(1);
    counter.release('k');
    counter.release('k');
    expect(counter.hit('k', 60, false).count).toBe(0);
    counter.release('never-seen');
    nowMs += 120_000;
    counter.release('k'); // expired: nothing to give back
    expect(counter.hit('k', 60, false).count).toBe(0);
  });
});
