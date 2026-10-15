import { backoffMs, decideRetry, eventExpiresAt } from './retry-policy';
import { toErrorCode } from './outbox-store';

const cfg = {
  backoffBaseMs: 30_000,
  backoffCapMs: 6 * 3_600_000,
  maxAttempts: 7,
};
const HOUR = 3_600_000;

describe('backoffMs', () => {
  it('grows by 4x per attempt and is capped', () => {
    const mid = () => 0.5; // jitter factor exactly 1.0
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n, cfg, mid))).toEqual([
      30_000,
      120_000,
      480_000,
      1_920_000,
      7_680_000,
      6 * HOUR, // 30s * 4^5 = 8.5 h, capped
      6 * HOUR,
    ]);
  });

  it('jitters by +-20% so retries do not move in lockstep', () => {
    expect(backoffMs(1, cfg, () => 0)).toBe(24_000);
    expect(backoffMs(1, cfg, () => 1)).toBe(36_000);
    const seen = new Set(Array.from({ length: 50 }, () => backoffMs(3, cfg)));
    expect(seen.size).toBeGreaterThan(10);
  });

  it('is always a positive whole number', () => {
    for (let n = 0; n < 12; n += 1) {
      const delay = backoffMs(n, { backoffBaseMs: 1, backoffCapMs: 1 });
      expect(Number.isInteger(delay) && delay >= 1).toBe(true);
    }
  });
});

describe('eventExpiresAt', () => {
  const created = new Date('2026-10-20T12:00:00Z');
  it('uses per-event-type windows, not one global cut-off', () => {
    expect(eventExpiresAt('order.status.ready', created, null)).toEqual(
      new Date(created.getTime() + 3 * HOUR),
    );
    expect(eventExpiresAt('order.checkout.completed', created, null)).toEqual(
      new Date(created.getTime() + 12 * HOUR),
    );
    expect(
      eventExpiresAt('careers.application.submitted', created, null),
    ).toEqual(new Date(created.getTime() + 7 * 24 * HOUR));
  });
  it('an event type with no policy never goes stale', () => {
    expect(eventExpiresAt('something.new', created, null)).toBeNull();
  });
  it('an expiry stored on the event wins', () => {
    const explicit = new Date('2026-10-20T12:30:00Z');
    expect(eventExpiresAt('order.status.ready', created, explicit)).toBe(
      explicit,
    );
  });
});

describe('decideRetry', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const mid = () => 0.5;
  it('schedules a retry while attempts remain', () => {
    expect(
      decideRetry({
        attempt: 1,
        now,
        expiresAt: null,
        config: cfg,
        random: mid,
      }),
    ).toEqual({
      action: 'retry',
      delayMs: 30_000,
    });
  });
  it('dead-letters when the attempts are used up', () => {
    expect(
      decideRetry({
        attempt: 7,
        now,
        expiresAt: null,
        config: cfg,
        random: mid,
      }),
    ).toEqual({
      action: 'dead',
      code: 'RETRIES_EXHAUSTED',
    });
  });
  it('dead-letters instead of scheduling past the expiry', () => {
    const expiresAt = new Date(now.getTime() + 20_000);
    expect(
      decideRetry({ attempt: 1, now, expiresAt, config: cfg, random: mid }),
    ).toEqual({
      action: 'dead',
      code: 'EVENT_EXPIRED',
    });
  });
  it('still retries when the next attempt fits before the expiry', () => {
    const expiresAt = new Date(now.getTime() + 10 * 60_000);
    expect(
      decideRetry({ attempt: 1, now, expiresAt, config: cfg, random: mid })
        .action,
    ).toBe('retry');
  });
});

describe('toErrorCode (the S4a lastErrorCode CHECK)', () => {
  it.each([
    ['Throttling', 'THROTTLING'],
    ['MessageRejected', 'MESSAGE_REJECTED'],
    [
      'MailFromDomainNotVerifiedException',
      'MAIL_FROM_DOMAIN_NOT_VERIFIED_EXCEPTION',
    ],
    ['SEND_TIMEOUT', 'SEND_TIMEOUT'],
    ['weird code!', 'WEIRD_CODE'],
    ['9lives', 'E_9LIVES'],
    ['', 'UNKNOWN_ERROR'],
    ['!!!', 'UNKNOWN_ERROR'],
  ])('%p -> %p', (raw, expected) => {
    expect(toErrorCode(raw)).toBe(expected);
    expect(toErrorCode(raw)).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
  });
  it('bounds the length to what the database accepts', () => {
    const code = toErrorCode('A'.repeat(200));
    expect(code).toHaveLength(64);
    expect(code).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
  });
});
