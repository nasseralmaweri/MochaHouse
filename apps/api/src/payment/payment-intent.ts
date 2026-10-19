import type {
  PaymentAccountContext,
  PaymentIntentProvider,
  PaymentIntentResult,
} from '@mocha-house/integrations';
import type { Prisma } from '@mocha-house/database';
import type { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  openReconciliationCase,
  settle,
  settleHeld,
  type HeldDisposition,
} from './payment-charge';

// ESP-04 M2 — two-step (intent-based) food-order payments.
//
//   1. START (this request): the attempt is claimed exactly like a one-step
//      charge (NOT_SENT -> CHARGING, conditional, committed before the
//      provider is called), then the provider creates a payment intent for
//      the frozen amount with the attempt's server-generated key as its
//      idempotency key. Its first answer is recorded conditionally (settle):
//        requires customer action / payment method -> REQUIRES_CUSTOMER_ACTION
//          (status stays PENDING: live, holds kept, the intent named);
//        succeeded  -> SUCCEEDED;   failed / canceled -> FAILED;
//        processing -> AWAITING_CONFIRMATION (held, case);
//        unknown / error / timeout -> UNKNOWN (held, case).
//   2. The customer confirms in the browser. The browser's word is never
//      evidence of anything.
//   3. CHECK (a later request): the intent is RETRIEVED from the provider
//      and only its authoritative status moves the attempt, and only from
//      REQUIRES_CUSTOMER_ACTION or AWAITING_CONFIRMATION (conditional):
//        succeeded            -> SUCCEEDED (then the order, exactly once) —
//                                only when the provider took exactly the
//                                frozen amount and currency; otherwise held
//                                for people (reconciliation case);
//        requires action /
//          payment method     -> unchanged: the customer may try again on
//                                the SAME intent (holds kept);
//        processing           -> AWAITING_CONFIRMATION (held, holds kept, a
//                                reconciliation case makes it visible); the
//                                customer is never asked to pay again, and
//                                later checks keep reading the provider;
//        canceled             -> FAILED: no charge can occur any more, so
//                                the database releases the holds (and a case
//                                opened while processing resolves NOT_CHARGED);
//        unknown / error      -> unchanged (holds kept).
// The client secret a browser needs is fetched from the provider when it is
// needed (clientSecretFor) and never stored or logged here.

export type IntentStart =
  | { kind: 'succeeded'; reference: string }
  | { kind: 'customer-action'; reference: string }
  | { kind: 'failed'; reason: string }
  | HeldDisposition
  | { kind: 'not-claimed' };

export type IntentCheck =
  | { kind: 'succeeded' }
  | {
      kind: 'customer-action';
      state: 'REQUIRES_CUSTOMER_ACTION' | 'REQUIRES_PAYMENT_METHOD';
    }
  | { kind: 'processing' }
  | { kind: 'failed' }
  | { kind: 'unknown' }
  // The attempt is no longer waiting for its customer (another request
  // settled it meanwhile): the caller re-reads it.
  | { kind: 'not-waiting' };

const TIMEOUT = Symbol('provider-timeout');

const PROCESSING_REASON = 'The payment provider is processing the payment.';
const AMOUNT_MISMATCH_REASON =
  'The payment provider reported a different amount or currency than this checkout.';

// The provider took exactly what the frozen checkout charges.
function tookFrozenAmount(
  result: { amount: number; currency: string },
  expected: { amount: number; currency: string },
): boolean {
  return (
    result.amount === expected.amount &&
    result.currency.toUpperCase() === expected.currency.toUpperCase()
  );
}

async function withTimeout<T>(
  call: () => Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(),
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The restaurant account a payment is taken for: from OUR records of the
// business only (its connected payment account, ESP-04 M1), never from a
// request.
export async function paymentAccountContext(
  prisma: PrismaService,
  tenantId: string,
): Promise<PaymentAccountContext> {
  const account = await prisma.tenantPaymentAccount.findUnique({
    where: { tenantId },
    select: { externalAccountId: true },
  });
  return { tenantId, connectedAccountId: account?.externalAccountId ?? null };
}

export async function startPaymentIntent(
  prisma: PrismaService,
  provider: PaymentIntentProvider,
  attempt: { id: string; idempotencyKey: string },
  input: {
    amount: number;
    currency: string;
    account: PaymentAccountContext;
    metadata?: Record<string, string>;
  },
  timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
): Promise<IntentStart> {
  const claim = await prisma.paymentAttempt.updateMany({
    where: { id: attempt.id, status: 'PENDING', paymentState: 'NOT_SENT' },
    data: { paymentState: 'CHARGING' },
  });
  if (claim.count === 0) return { kind: 'not-claimed' };

  let result: PaymentIntentResult;
  try {
    const answer = await withTimeout(
      () =>
        provider.createPaymentIntent({
          idempotencyKey: attempt.idempotencyKey,
          amount: input.amount,
          currency: input.currency,
          account: input.account,
          metadata: input.metadata,
        }),
      timeoutMs,
    );
    result =
      answer === TIMEOUT
        ? {
            status: 'unknown',
            reason: `Payment provider did not respond within ${timeoutMs}ms.`,
          }
        : answer;
  } catch {
    result = {
      status: 'unknown',
      reason: 'Payment provider did not return a result.',
    };
  }

  switch (result.status) {
    case 'requires_customer_action':
    case 'requires_payment_method':
      return settle(
        prisma,
        attempt.id,
        {
          paymentState: 'REQUIRES_CUSTOMER_ACTION',
          providerReference: result.reference,
        },
        { kind: 'customer-action' as const, reference: result.reference },
      );
    case 'succeeded':
      if (!tookFrozenAmount(result, input)) {
        return settleHeld(
          prisma,
          attempt.id,
          {
            paymentState: 'UNKNOWN',
            providerReference: result.reference,
            failureReason: AMOUNT_MISMATCH_REASON,
          },
          { kind: 'held', state: 'UNKNOWN', reason: AMOUNT_MISMATCH_REASON },
        ) as Promise<HeldDisposition>;
      }
      return settle(
        prisma,
        attempt.id,
        {
          status: 'SUCCEEDED',
          paymentState: 'SUCCEEDED',
          providerReference: result.reference,
        },
        { kind: 'succeeded' as const, reference: result.reference },
      );
    case 'canceled':
    case 'failed': {
      const reason =
        result.status === 'canceled'
          ? 'The payment intent was cancelled.'
          : result.reason.slice(0, 500);
      return settle(
        prisma,
        attempt.id,
        {
          status: 'FAILED',
          paymentState: 'FAILED',
          failureReason: reason,
          ...(result.status === 'canceled'
            ? { providerReference: result.reference }
            : {}),
        },
        { kind: 'failed' as const, reason },
      );
    }
    case 'processing':
      return settleHeld(
        prisma,
        attempt.id,
        {
          paymentState: 'AWAITING_CONFIRMATION',
          providerReference: result.reference,
          failureReason: PROCESSING_REASON,
        },
        {
          kind: 'held',
          state: 'AWAITING_CONFIRMATION',
          reason: PROCESSING_REASON,
        },
      ) as Promise<HeldDisposition>;
    default:
      return settleHeld(
        prisma,
        attempt.id,
        {
          paymentState: 'UNKNOWN',
          failureReason: result.reason.slice(0, 500),
          ...(result.reference ? { providerReference: result.reference } : {}),
        },
        { kind: 'held', state: 'UNKNOWN', reason: result.reason },
      ) as Promise<HeldDisposition>;
  }
}

// Reads the intent back from the provider and moves the attempt ONLY on the
// provider's definitive answer, and only from REQUIRES_CUSTOMER_ACTION or
// AWAITING_CONFIRMATION.
export async function checkPaymentIntent(
  prisma: PrismaService,
  provider: PaymentIntentProvider,
  attempt: {
    id: string;
    tenantId: string;
    providerReference: string;
    paymentState: string | null;
    amount: number;
    currency: string;
  },
  account: PaymentAccountContext,
  timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
): Promise<IntentCheck> {
  let result: PaymentIntentResult;
  try {
    const answer = await withTimeout(
      () =>
        provider.retrievePaymentIntent({
          reference: attempt.providerReference,
          account,
        }),
      timeoutMs,
    );
    if (answer === TIMEOUT) return { kind: 'unknown' };
    result = answer;
  } catch {
    return { kind: 'unknown' };
  }
  // An answer about any other intent proves nothing about this one.
  if (
    result.status !== 'failed' &&
    result.status !== 'unknown' &&
    result.reference !== attempt.providerReference
  ) {
    return { kind: 'unknown' };
  }
  const waiting = {
    id: attempt.id,
    tenantId: attempt.tenantId,
    status: 'PENDING' as const,
    paymentState: { in: ['REQUIRES_CUSTOMER_ACTION', 'AWAITING_CONFIRMATION'] },
  };
  switch (result.status) {
    case 'succeeded': {
      if (!tookFrozenAmount(result, attempt)) {
        // Money moved, but not what this checkout charges: never recorded as
        // paid and never released — held for people.
        await openReconciliationCase(
          prisma,
          attempt.id,
          'PROVIDER_AMOUNT_MISMATCH',
          { outcome: 'unknown' },
        );
        return { kind: 'unknown' };
      }
      const moved = await prisma.paymentAttempt.updateMany({
        where: waiting,
        data: { status: 'SUCCEEDED', paymentState: 'SUCCEEDED' },
      });
      return moved.count === 1
        ? { kind: 'succeeded' }
        : { kind: 'not-waiting' };
    }
    case 'requires_customer_action':
      return { kind: 'customer-action', state: 'REQUIRES_CUSTOMER_ACTION' };
    case 'requires_payment_method':
      return { kind: 'customer-action', state: 'REQUIRES_PAYMENT_METHOD' };
    case 'processing': {
      // Money may be moving: held (never a prompt to pay again) and visible
      // to people. Later checks keep reading the provider.
      if (attempt.paymentState === 'REQUIRES_CUSTOMER_ACTION') {
        await prisma.paymentAttempt.updateMany({
          where: { ...waiting, paymentState: 'REQUIRES_CUSTOMER_ACTION' },
          data: {
            paymentState: 'AWAITING_CONFIRMATION',
            failureReason: PROCESSING_REASON,
          },
        });
      }
      await openReconciliationCase(
        prisma,
        attempt.id,
        'PROVIDER_AWAITING_CONFIRMATION',
        { outcome: 'pending' },
      );
      return { kind: 'processing' };
    }
    case 'canceled': {
      // No charge can occur on a cancelled intent: the attempt closes and the
      // database releases its holds in the same statement; a case opened
      // while it was processing is resolved as NOT_CHARGED with it.
      const moved = await prisma.$transaction(async (tx) => {
        const closed = await tx.paymentAttempt.updateMany({
          where: waiting,
          data: {
            status: 'FAILED',
            paymentState: 'FAILED',
            failureReason: 'The payment intent was cancelled.',
          },
        });
        if (closed.count === 1) {
          await resolveCaseAsNotCharged(tx, attempt.tenantId, attempt.id);
        }
        return closed.count;
      });
      return moved === 1 ? { kind: 'failed' } : { kind: 'not-waiting' };
    }
    default:
      // "failed" or "unknown" from a READ is not a definitive outcome.
      return { kind: 'unknown' };
  }
}

// A payment the provider confirmed was never charged (its intent was
// cancelled): its open case, if any, is resolved as NOT_CHARGED with a SYSTEM
// event, in the caller's transaction (the one that closed the payment).
async function resolveCaseAsNotCharged(
  tx: Prisma.TransactionClient,
  tenantId: string,
  paymentAttemptId: string,
): Promise<void> {
  const open = await tx.paymentReconciliationCase.findUnique({
    where: { tenantId_paymentAttemptId: { tenantId, paymentAttemptId } },
    select: { id: true, status: true },
  });
  if (!open || open.status === 'RESOLVED') return;
  const resolved = await tx.paymentReconciliationCase.updateMany({
    where: { id: open.id, tenantId, status: { not: 'RESOLVED' } },
    data: {
      status: 'RESOLVED',
      resolution: 'NOT_CHARGED',
      resolvedAt: new Date(),
    },
  });
  if (resolved.count !== 1) return;
  await tx.paymentReconciliationEvent.create({
    data: {
      tenantId,
      caseId: open.id,
      actorKind: 'SYSTEM',
      action: 'RESOLVED',
      detail: {
        source: 'payment-intent',
        resolution: 'NOT_CHARGED',
        from: open.status,
        to: 'RESOLVED',
        paymentAttemptId,
      },
    },
  });
}
