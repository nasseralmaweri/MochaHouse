// R1 / S4b — pure retry and staleness policy. No I/O, so it is unit-testable
// without a database.

import type { OutboxConfig } from './outbox.config';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Event-specific staleness: how long after creation a notification is still
// worth sending. There is deliberately no single global cut-off. A database
// value (OutboxEvent.expiresAt, set by a producer) overrides this table; an
// event type not listed here never goes stale.
export const EVENT_MAX_AGE_MS: Readonly<Record<string, number>> = {
  // "We received your order" — useful until the order is long since collected.
  'order.checkout.completed': 12 * HOUR,
  // "Your order is ready for pickup" — meaningless a few hours later.
  'order.status.ready': 3 * HOUR,
  // Internal notices to the business: a late one is still informative.
  'careers.application.submitted': 7 * DAY,
  'franchising.inquiry.submitted': 7 * DAY,
};

export function eventExpiresAt(
  eventType: string,
  createdAt: Date,
  expiresAt: Date | null,
): Date | null {
  if (expiresAt) return expiresAt;
  const maxAge = EVENT_MAX_AGE_MS[eventType];
  return maxAge === undefined ? null : new Date(createdAt.getTime() + maxAge);
}

// Exponential backoff with jitter. `attempt` is the attempt that just failed
// (1-based): the delay after attempt 1 is `base`, then x4 each time, capped.
// Jitter is +-20% so a burst of failures does not retry in lockstep.
export function backoffMs(
  attempt: number,
  config: Pick<OutboxConfig, 'backoffBaseMs' | 'backoffCapMs'>,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(
    config.backoffCapMs,
    config.backoffBaseMs * Math.pow(4, exponent),
  );
  const jitter = 0.8 + 0.4 * random();
  return Math.max(1, Math.round(raw * jitter));
}

export type FailureKind =
  // The provider answered and did not accept the message: definitely not sent.
  | 'definite-transient'
  | 'definite-permanent'
  // No answer (timeout, connection loss, unknown error): the message may have
  // been accepted.
  | 'ambiguous';

export interface RetryDecision {
  readonly action: 'retry' | 'dead';
  readonly delayMs?: number;
  readonly code?: string;
}

// Decides what happens to an event after a retryable failure.
export function decideRetry(input: {
  attempt: number;
  now: Date;
  expiresAt: Date | null;
  config: Pick<OutboxConfig, 'maxAttempts' | 'backoffBaseMs' | 'backoffCapMs'>;
  random?: () => number;
}): RetryDecision {
  if (input.attempt >= input.config.maxAttempts) {
    return { action: 'dead', code: 'RETRIES_EXHAUSTED' };
  }
  const delayMs = backoffMs(input.attempt, input.config, input.random);
  if (
    input.expiresAt &&
    input.now.getTime() + delayMs >= input.expiresAt.getTime()
  ) {
    // The next attempt would land after the notification has gone stale.
    return { action: 'dead', code: 'EVENT_EXPIRED' };
  }
  return { action: 'retry', delayMs };
}
