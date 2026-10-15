import type {
  NotificationHealthAttention,
  NotificationHealthResponse,
  NotificationHealthStatus,
} from '@mocha-house/contracts';

// R1 / S4c — turns notification counts into "does anyone need to do something".
// Pure (no I/O) so the rules are unit-tested without a database.
//
// An ORDINARY retry is not a problem: one failed attempt followed by a retry a
// few seconds or minutes later is exactly what the worker is for. What needs a
// person is:
//   - a notification that has been dead-lettered (it will not be tried again),
//   - notifications nobody is processing (due for longer than the threshold:
//     the worker is stopped, held back, or cannot keep up),
//   - notifications that keep failing (several attempts: provider or
//     configuration trouble that will not fix itself soon),
//   - and, for information, messages that may have been sent twice.

export const DELAYED_AFTER_SECONDS = 5 * 60;
export const CRITICAL_DELAY_SECONDS = 30 * 60;
export const REPEATED_FAILURE_ATTEMPTS = 3;

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 } as const;

// The rules need no knowledge of deliberate closures (already excluded upstream).
type Summary = Pick<
  NotificationHealthResponse,
  'pending' | 'possibleDuplicatesLast7d'
> & {
  failed: Omit<NotificationHealthResponse['failed'], 'closedDeliberately'>;
};

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

function topReasons(reasons: { code: string; count: number }[]): string {
  const shown = reasons.slice(0, 3).map((r) => `${r.code} (${r.count})`);
  return shown.length > 0 ? ` Main reasons: ${shown.join(', ')}.` : '';
}

export function buildAttention(
  summary: Summary,
): NotificationHealthAttention[] {
  const attention: NotificationHealthAttention[] = [];
  const { pending, failed } = summary;

  if (failed.last24h > 0) {
    attention.push({
      key: 'DEAD_LETTERED',
      severity: 'critical',
      title: `${plural(failed.last24h, 'notification', 'notifications')} could not be sent`,
      detail:
        `In the last 24 hours ${plural(failed.last24h, 'notification was', 'notifications were')} given up on and will not be tried again.` +
        topReasons(failed.reasons),
      count: failed.last24h,
    });
  } else if (failed.last7d > 0) {
    attention.push({
      key: 'DEAD_LETTERED',
      severity: 'warning',
      title: `${plural(failed.last7d, 'notification', 'notifications')} could not be sent this week`,
      detail:
        'None in the last 24 hours, but earlier failures have not been reviewed here.' +
        topReasons(failed.reasons),
      count: failed.last7d,
    });
  }

  if (pending.delayed > 0) {
    const overdue = pending.oldestOverdueSeconds ?? 0;
    attention.push({
      key: 'DELAYED',
      severity: overdue >= CRITICAL_DELAY_SECONDS ? 'critical' : 'warning',
      title: `${plural(pending.delayed, 'notification is', 'notifications are')} not being processed`,
      detail: `Due for ${Math.round(overdue / 60)} minute(s) and still not picked up. The notification worker may be stopped or held back.`,
      count: pending.delayed,
    });
  }

  if (pending.repeatedlyFailing > 0) {
    attention.push({
      key: 'REPEATED_FAILURES',
      severity: 'warning',
      title: `${plural(pending.repeatedlyFailing, 'notification keeps', 'notifications keep')} failing`,
      detail:
        `Failed ${REPEATED_FAILURE_ATTEMPTS} or more times and still being retried. This usually means a problem with the email provider or its configuration.` +
        topReasons(pending.retryReasons),
      count: pending.repeatedlyFailing,
    });
  }

  if (summary.possibleDuplicatesLast7d > 0) {
    attention.push({
      key: 'POSSIBLE_DUPLICATES',
      severity: 'info',
      title: `${plural(summary.possibleDuplicatesLast7d, 'message may', 'messages may')} have been sent twice`,
      detail:
        'An earlier send ended without an answer from the email provider and was retried once. For information only.',
      count: summary.possibleDuplicatesLast7d,
    });
  }

  return attention.sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
}

// Informational notes never change the overall status.
export function overallStatus(
  attention: NotificationHealthAttention[],
): NotificationHealthStatus {
  if (attention.some((a) => a.severity === 'critical')) return 'critical';
  if (attention.some((a) => a.severity === 'warning')) return 'warning';
  return 'ok';
}
