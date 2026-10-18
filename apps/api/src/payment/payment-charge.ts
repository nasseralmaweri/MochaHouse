import { Logger } from '@nestjs/common';
import type { ChargeRequest, PaymentProvider } from '@mocha-house/integrations';
import type { Prisma } from '@mocha-house/database';
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
//   * ESP-03 PR 3 — an outcome that is not final (UNKNOWN or
//     AWAITING_CONFIRMATION), or a result that could not be recorded, opens
//     a PaymentReconciliationCase (with a SYSTEM "OPENED" event) so the held
//     payment is visible to people. A provider reference is always kept when
//     the provider returned one, even if the outcome write itself was lost.
//     Opening a case is best effort: a failure is logged and never fails the
//     request (money may already have moved), and the attempt stays held.
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
      return settleHeld(
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
      return settleHeld(
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
//
// ESP-03 PR 3 — if that write is lost (another writer moved the row) or
// throws, the provider's answer is not discarded: its reference is kept when
// it has one, a reconciliation case is opened, and the caller is told the
// payment is held. Nothing here charges again.
async function settle(
  prisma: PrismaService,
  attemptId: string,
  data: Record<string, unknown>,
  result: ChargeDisposition,
): Promise<ChargeDisposition> {
  let written = false;
  try {
    const done = await prisma.paymentAttempt.updateMany({
      where: { id: attemptId, paymentState: 'CHARGING' },
      data,
    });
    written = done.count === 1;
  } catch (error) {
    // The provider reference is not personal data: logged so a payment the
    // provider took is traceable even if nothing below can be written.
    logger.error(
      `payment attempt ${attemptId}: the provider outcome (${result.kind}${
        typeof data.providerReference === 'string'
          ? `, reference ${data.providerReference}`
          : ''
      }) could not be recorded (${errorName(error)})`,
    );
  }
  if (written) {
    return result;
  }
  const providerReference =
    typeof data.providerReference === 'string' ? data.providerReference : null;
  await keepProviderReference(prisma, attemptId, providerReference);
  await openReconciliationCase(
    prisma,
    attemptId,
    result.kind === 'succeeded'
      ? 'PROVIDER_SUCCEEDED_UNRECORDED'
      : 'PROVIDER_OUTCOME_UNRECORDED',
    { outcome: result.kind },
  );
  return {
    kind: 'held',
    state: 'UNKNOWN',
    reason: 'The payment state changed while the charge was in flight.',
  };
}

// A held outcome (provider pending, or unknown) is recorded like any other;
// once recorded it also opens a case so a person sees the held payment.
async function settleHeld(
  prisma: PrismaService,
  attemptId: string,
  data: Record<string, unknown>,
  result: ChargeDisposition & { kind: 'held' },
): Promise<ChargeDisposition> {
  const settled = await settle(prisma, attemptId, data, result);
  if (settled === result) {
    const pending = result.state === 'AWAITING_CONFIRMATION';
    await openReconciliationCase(
      prisma,
      attemptId,
      pending ? 'PROVIDER_AWAITING_CONFIRMATION' : 'PROVIDER_OUTCOME_UNKNOWN',
      { outcome: pending ? 'pending' : 'unknown' },
    );
  }
  return settled;
}

const logger = new Logger('PaymentCharge');

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

// Keeps the provider's reference for a payment whose result could not be
// recorded: only fills an empty reference, never replaces one.
async function keepProviderReference(
  prisma: PrismaService,
  attemptId: string,
  providerReference: string | null,
): Promise<void> {
  if (providerReference === null) return;
  try {
    await prisma.paymentAttempt.updateMany({
      where: { id: attemptId, providerReference: null },
      data: { providerReference },
    });
  } catch (error) {
    logger.error(
      `payment attempt ${attemptId}: provider reference ${providerReference} could not be kept (${errorName(error)})`,
    );
  }
}

// Opens the attempt's reconciliation case (at most one per attempt, by the
// table's unique key) with a SYSTEM "OPENED" event, in one transaction. An
// existing case is left as it is. `detail` holds only fixed codes — never
// provider text, personal data, keys or tokens.
export async function openReconciliationCase(
  prisma: PrismaService,
  attemptId: string,
  reasonCode: string,
  detail: Record<string, string>,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const attempt = await tx.paymentAttempt.findUnique({
        where: { id: attemptId },
        select: { tenantId: true },
      });
      if (!attempt) return;
      const existing = await tx.paymentReconciliationCase.findUnique({
        where: {
          tenantId_paymentAttemptId: {
            tenantId: attempt.tenantId,
            paymentAttemptId: attemptId,
          },
        },
        select: { id: true },
      });
      if (existing) return;
      const opened = await tx.paymentReconciliationCase.create({
        data: {
          tenantId: attempt.tenantId,
          paymentAttemptId: attemptId,
          status: 'OPEN',
          reasonCode,
        },
        select: { id: true },
      });
      await tx.paymentReconciliationEvent.create({
        data: {
          tenantId: attempt.tenantId,
          caseId: opened.id,
          actorKind: 'SYSTEM',
          action: 'OPENED',
          detail: { source: 'payment-charge', reasonCode, ...detail },
        },
      });
    });
  } catch (error) {
    // A concurrent opener won (unique key): the case exists. Anything else
    // (the database is unavailable) is logged; either way the attempt stays
    // held and nothing is charged again.
    if ((error as { code?: unknown } | null)?.code !== 'P2002') {
      logger.error(
        `payment attempt ${attemptId}: a reconciliation case could not be opened (${errorName(error)})`,
      );
    }
  }
}

// ESP-03 PR 4 — a payment whose order (or gift card) now exists no longer
// needs review: its open case, if any, is resolved as FULFILLED with a
// SYSTEM event, in the caller's transaction (the one that fulfilled it).
export async function resolveCaseAsFulfilled(
  tx: Prisma.TransactionClient,
  tenantId: string,
  paymentAttemptId: string,
): Promise<void> {
  const open = await tx.paymentReconciliationCase.findUnique({
    where: { tenantId_paymentAttemptId: { tenantId, paymentAttemptId } },
    select: { id: true, status: true },
  });
  if (!open || open.status === 'RESOLVED') return;
  await tx.paymentReconciliationCase.updateMany({
    where: { id: open.id, tenantId, status: { not: 'RESOLVED' } },
    data: {
      status: 'RESOLVED',
      resolution: 'FULFILLED',
      resolvedAt: new Date(),
    },
  });
  await tx.paymentReconciliationEvent.create({
    data: {
      tenantId,
      caseId: open.id,
      actorKind: 'SYSTEM',
      action: 'RESOLVED',
      detail: { source: 'fulfilment', resolution: 'FULFILLED' },
    },
  });
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

// ESP-03 PR 3 — what a customer is told about a definitive decline or
// failure. Fixed wording only: the provider's own reason text stays in the
// attempt's internal failureReason and is never sent to a customer.
export const PAYMENT_DECLINED_MESSAGE =
  'Your payment was declined. Nothing was charged. Please try another payment method.';
export const PAYMENT_FAILED_MESSAGE =
  'Your payment could not be completed. Nothing was charged. Please try again.';

export function customerPaymentMessage(outcome: 'declined' | 'failed'): string {
  return outcome === 'declined'
    ? PAYMENT_DECLINED_MESSAGE
    : PAYMENT_FAILED_MESSAGE;
}

export const HELD_PAYMENT_MESSAGE =
  'Your payment is being confirmed. Do not pay again — we will update the ' +
  'order as soon as the payment provider confirms the result.';
