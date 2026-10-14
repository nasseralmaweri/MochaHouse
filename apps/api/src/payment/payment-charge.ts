import type { ChargeRequest, PaymentProvider } from '@mocha-house/integrations';
import type { PrismaService } from '../prisma/prisma.service';

// ESP-03 PR 2 — the ONE place a payment provider is charged for a
// PaymentAttempt, shared by checkout and the gift-card purchase so both obey
// the same state machine:
//
//   NOT_SENT ──claim──▶ CHARGING ──▶ SUCCEEDED | DECLINED | FAILED   (definitive)
//                                └─▶ AWAITING_CONFIRMATION           (provider pending)
//                                └─▶ UNKNOWN                         (throw / timeout / "unknown")
//
// Rules this module enforces:
//   * CHARGING is committed BEFORE the provider is called. A crash between
//     the claim and the outcome therefore leaves CHARGING (held), never a
//     row that looks safe to charge again.
//   * The provider is always called with the attempt's own persisted
//     idempotencyKey — the same key for every call about this payment, so a
//     provider that deduplicates by key can never see a second charge under
//     a new key.
//   * A provider exception or timeout is UNKNOWN, never FAILED: the charge
//     may have gone through. UNKNOWN / AWAITING_CONFIRMATION / CHARGING are
//     all held; nothing here ever charges them again.
//   * Every transition is a conditional updateMany guarded by the expected
//     current state, so concurrent callers cannot both win it.
//   * Rows from before ESP-03 have paymentState NULL and keep the legacy
//     `status`-driven semantics; this module never guesses their outcome.
//
// The legacy `status` column is kept consistent for readers that predate
// paymentState: it moves to SUCCEEDED / DECLINED / FAILED only on a
// definitive outcome and stays PENDING while the outcome is held.

export type HeldPaymentState = 'CHARGING' | 'AWAITING_CONFIRMATION' | 'UNKNOWN';

export type ChargeDisposition =
  | { kind: 'succeeded'; providerReference: string }
  | { kind: 'declined' | 'failed'; reason: string }
  // Outcome not known to be final. The caller must NOT retry the charge.
  | { kind: 'held'; state: HeldPaymentState; reason: string }
  // Another request already owns (or owned) the charge for this attempt.
  | { kind: 'not-claimed' };

export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

export interface ChargeAttemptOptions {
  // Gift-card intents created before ESP-03 have paymentState NULL and were
  // never charged; the purchase's own permanent charge claim (checked by the
  // caller first) proves that, so they may enter CHARGING as well.
  allowLegacyNullState?: boolean;
  timeoutMs?: number;
}

type ChargeInput = Omit<ChargeRequest, 'idempotencyKey'>;

const PROVIDER_TIMEOUT = Symbol('provider-timeout');

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Payment provider did not return a result (${message}).`.slice(0, 500);
}

export async function chargeAttempt(
  prisma: PrismaService,
  provider: PaymentProvider,
  attempt: { id: string; idempotencyKey: string },
  input: ChargeInput,
  options: ChargeAttemptOptions = {},
): Promise<ChargeDisposition> {
  const claim = await prisma.paymentAttempt.updateMany({
    where: {
      id: attempt.id,
      status: 'PENDING',
      OR: options.allowLegacyNullState
        ? [{ paymentState: 'NOT_SENT' }, { paymentState: null }]
        : [{ paymentState: 'NOT_SENT' }],
    },
    data: { paymentState: 'CHARGING' },
  });
  if (claim.count === 0) {
    return { kind: 'not-claimed' };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: Awaited<ReturnType<PaymentProvider['charge']>>;
  try {
    const result = await Promise.race([
      provider.charge({ ...input, idempotencyKey: attempt.idempotencyKey }),
      new Promise<typeof PROVIDER_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(PROVIDER_TIMEOUT), timeoutMs);
      }),
    ]);
    if (result === PROVIDER_TIMEOUT) {
      outcome = {
        outcome: 'unknown',
        reason: `Payment provider did not respond within ${timeoutMs}ms.`,
      };
    } else {
      outcome = result;
    }
  } catch (error) {
    outcome = { outcome: 'unknown', reason: reasonOf(error) };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }

  // A malformed provider result is not trusted to mean "nothing happened".
  const known = ['succeeded', 'declined', 'failed', 'pending', 'unknown'];
  if (!outcome || !known.includes((outcome as { outcome: string }).outcome)) {
    outcome = {
      outcome: 'unknown',
      reason: 'Payment provider returned an unrecognised result.',
    };
  }

  switch (outcome.outcome) {
    case 'succeeded':
      return settle(
        prisma,
        attempt.id,
        {
          status: 'SUCCEEDED',
          paymentState: 'SUCCEEDED',
          providerReference: outcome.providerReference,
        },
        { kind: 'succeeded', providerReference: outcome.providerReference },
      );
    case 'declined':
      return settle(
        prisma,
        attempt.id,
        {
          status: 'DECLINED',
          paymentState: 'DECLINED',
          failureReason: outcome.reason,
        },
        { kind: 'declined', reason: outcome.reason },
      );
    case 'failed':
      return settle(
        prisma,
        attempt.id,
        {
          status: 'FAILED',
          paymentState: 'FAILED',
          failureReason: outcome.reason,
        },
        { kind: 'failed', reason: outcome.reason },
      );
    case 'pending':
      return settle(
        prisma,
        attempt.id,
        {
          paymentState: 'AWAITING_CONFIRMATION',
          failureReason: outcome.reason.slice(0, 500),
          ...(outcome.providerReference
            ? { providerReference: outcome.providerReference }
            : {}),
        },
        {
          kind: 'held',
          state: 'AWAITING_CONFIRMATION',
          reason: outcome.reason,
        },
      );
    default:
      return settle(
        prisma,
        attempt.id,
        {
          paymentState: 'UNKNOWN',
          failureReason: outcome.reason.slice(0, 500),
        },
        { kind: 'held', state: 'UNKNOWN', reason: outcome.reason },
      );
  }
}

// Conditional on the claim still being ours (CHARGING). If something else
// moved the row (a future reconciler), report the row's real state rather
// than overwriting it.
async function settle(
  prisma: PrismaService,
  attemptId: string,
  data: Record<string, unknown>,
  result: ChargeDisposition,
): Promise<ChargeDisposition> {
  const done = await prisma.paymentAttempt.updateMany({
    where: { id: attemptId, paymentState: 'CHARGING' },
    data,
  });
  if (done.count === 1) {
    return result;
  }
  return {
    kind: 'held',
    state: 'UNKNOWN',
    reason: 'The payment state changed while the charge was in flight.',
  };
}

// What a caller that did NOT win the claim should tell its client, derived
// from the persisted row. `null` = not a held state (use the legacy replay).
export function heldStateOf(attempt: {
  status: string;
  paymentState: string | null;
}): HeldPaymentState | null {
  if (attempt.status !== 'PENDING') {
    return null;
  }
  if (
    attempt.paymentState === 'CHARGING' ||
    attempt.paymentState === 'AWAITING_CONFIRMATION' ||
    attempt.paymentState === 'UNKNOWN'
  ) {
    return attempt.paymentState;
  }
  return null;
}

export const HELD_PAYMENT_MESSAGE =
  'Your payment is being confirmed. Do not pay again — we will update the ' +
  'order as soon as the payment provider confirms the result.';
