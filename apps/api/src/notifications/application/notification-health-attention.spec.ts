import type { NotificationHealthResponse } from '@mocha-house/contracts';
import {
  CRITICAL_DELAY_SECONDS,
  buildAttention,
  overallStatus,
} from './notification-health-attention';

// The rules need no knowledge of deliberate closures (already excluded upstream).
type Summary = Pick<
  NotificationHealthResponse,
  'pending' | 'possibleDuplicatesLast7d'
> & {
  failed: Omit<NotificationHealthResponse['failed'], 'closedDeliberately'>;
};

const base = (): Summary => ({
  pending: {
    total: 0,
    waiting: 0,
    inProgress: 0,
    scheduledRetry: 0,
    delayed: 0,
    repeatedlyFailing: 0,
    oldestPendingAgeSeconds: null,
    oldestRetryingAgeSeconds: null,
    oldestOverdueSeconds: null,
    retryReasons: [],
  },
  failed: {
    total: 0,
    last24h: 0,
    last7d: 0,
    reasons: [],
  },
  possibleDuplicatesLast7d: 0,
});

const status = (s: Summary) => overallStatus(buildAttention(s));

describe('notification health attention rules', () => {
  it('nothing pending, nothing failed: ok and nothing to do', () => {
    expect(buildAttention(base())).toEqual([]);
    expect(status(base())).toBe('ok');
  });

  it('an ordinary retry (one or two failed attempts, backoff in progress) is NOT a problem', () => {
    const s = base();
    s.pending.total = 3;
    s.pending.scheduledRetry = 3;
    s.pending.oldestRetryingAgeSeconds = 600;
    s.pending.retryReasons = [{ code: 'THROTTLING', count: 3 }];
    expect(buildAttention(s)).toEqual([]);
    expect(status(s)).toBe('ok');
  });

  it('notifications that are merely waiting or being sent are not a problem', () => {
    const s = base();
    s.pending.total = 5;
    s.pending.waiting = 4;
    s.pending.inProgress = 1;
    expect(status(s)).toBe('ok');
  });

  it('a dead letter in the last 24 hours is critical and names the reasons', () => {
    const s = base();
    s.failed = {
      total: 2,
      last24h: 2,
      last7d: 2,
      reasons: [
        { code: 'MESSAGE_REJECTED', count: 1 },
        { code: 'NO_RECIPIENT', count: 1 },
      ],
    };
    const [item] = buildAttention(s);
    expect(item).toMatchObject({
      key: 'DEAD_LETTERED',
      severity: 'critical',
      count: 2,
    });
    expect(item.detail).toContain('MESSAGE_REJECTED (1)');
    expect(status(s)).toBe('critical');
  });

  it('older dead letters (only within the week) are a warning, not an emergency', () => {
    const s = base();
    s.failed = {
      total: 1,
      last24h: 0,
      last7d: 1,
      reasons: [{ code: 'EVENT_EXPIRED', count: 1 }],
    };
    expect(buildAttention(s)[0]).toMatchObject({
      key: 'DEAD_LETTERED',
      severity: 'warning',
    });
    expect(status(s)).toBe('warning');
  });

  it('dead letters older than a week are history, not an alert', () => {
    const s = base();
    s.failed = { total: 9, last24h: 0, last7d: 0, reasons: [] };
    expect(buildAttention(s)).toEqual([]);
  });

  it('due-but-unprocessed notifications mean the worker is stopped or held back: warning, then critical past the threshold', () => {
    const s = base();
    s.pending.delayed = 2;
    s.pending.oldestOverdueSeconds = 10 * 60;
    expect(buildAttention(s)[0]).toMatchObject({
      key: 'DELAYED',
      severity: 'warning',
    });
    expect(status(s)).toBe('warning');

    s.pending.oldestOverdueSeconds = CRITICAL_DELAY_SECONDS;
    expect(buildAttention(s)[0]).toMatchObject({
      key: 'DELAYED',
      severity: 'critical',
    });
    expect(status(s)).toBe('critical');
    expect(buildAttention(s)[0].detail).toContain('worker');
  });

  it('repeated failures (3+ attempts) are a warning with the retry reasons', () => {
    const s = base();
    s.pending.repeatedlyFailing = 1;
    s.pending.retryReasons = [{ code: 'SES_NOT_CONFIGURED', count: 1 }];
    const [item] = buildAttention(s);
    expect(item).toMatchObject({
      key: 'REPEATED_FAILURES',
      severity: 'warning',
    });
    expect(item.detail).toContain('SES_NOT_CONFIGURED (1)');
  });

  it('possible duplicates are information only and never change the status', () => {
    const s = base();
    s.possibleDuplicatesLast7d = 2;
    expect(buildAttention(s)).toEqual([
      expect.objectContaining({
        key: 'POSSIBLE_DUPLICATES',
        severity: 'info',
        count: 2,
      }),
    ]);
    expect(status(s)).toBe('ok');
  });

  it('orders the most severe first and takes the worst severity overall', () => {
    const s = base();
    s.possibleDuplicatesLast7d = 1;
    s.pending.repeatedlyFailing = 1;
    s.pending.delayed = 1;
    s.pending.oldestOverdueSeconds = 3600;
    s.failed = { total: 1, last24h: 1, last7d: 1, reasons: [] };
    expect(buildAttention(s).map((a) => a.severity)).toEqual([
      'critical',
      'critical',
      'warning',
      'info',
    ]);
    expect(status(s)).toBe('critical');
  });

  it('uses singular and plural wording correctly', () => {
    const one = base();
    one.failed = { total: 1, last24h: 1, last7d: 1, reasons: [] };
    expect(buildAttention(one)[0].title).toBe(
      '1 notification could not be sent',
    );
    const many = base();
    many.failed = { total: 3, last24h: 3, last7d: 3, reasons: [] };
    expect(buildAttention(many)[0].title).toBe(
      '3 notifications could not be sent',
    );
  });
});
