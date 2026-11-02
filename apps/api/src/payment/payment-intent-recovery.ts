import type {
  PaymentAccountContext,
  PaymentIntentProvider,
  PaymentIntentResult,
} from '@mocha-house/integrations';
import type { PrismaService } from '../prisma/prisma.service';
import { isIdempotencyMismatch } from '../restaurant-payments/provider/stripe-payment-intent-provider';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  openReconciliationCase,
} from './payment-charge';
import {
  intentCreationInput,
  noteOnCase,
  resolveCaseAsNotCharged,
} from './payment-intent';

// ESP-04 M4a — recovering a two-step payment whose outcome we do not know
// (held: CHARGING, UNKNOWN or AWAITING_CONFIRMATION) from Stripe itself.
// Used only by payment recovery (the sweeper and platform support), never by
// a customer request.
//
//   * Stripe's read-back is the only authority, made on the account the
//     payment was created on (recorded with its charge claim).
//   * Every move is a conditional update from the EXACT state and intent
//     reference that were read, so a concurrent webhook, customer check or
//     second recovery can never move it twice or backwards.
//   * Holds are released only when Stripe reports the intent cancelled with
//     nothing received (the database releases them with FAILED).
//   * A payment with no intent reference may have its creation REPLAYED —
//     the exact original request: the same idempotency key, the same
//     account, byte-identical parameters (the one shared builder) — and only
//     well inside Stripe's idempotency retention (API v1 keeps a key "at
//     least 24 hours"; after that a reused key is a NEW request). Never a new
//     key and never a new payment attempt. Any answer that is not an intent
//     — a cached 500, a conflict, a local refusal, a timeout — proves
//     nothing and changes nothing.

export const RECOVERABLE_HELD_STATES = [
  'CHARGING',
  'UNKNOWN',
  'AWAITING_CONFIRMATION',
] as const;
type HeldState = (typeof RECOVERABLE_HELD_STATES)[number];

// Fixed in code (decision 2): never configurable past Stripe's retention.
export const STRIPE_CREATE_REPLAY_WINDOW_MS = 20 * 60 * 60 * 1000;

export interface HeldPayment {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  amount: number;
  currency: string;
  paymentState: string | null;
  providerReference: string | null;
  createdAt: Date;
}

export type ReadBack =
  // SUCCEEDED (the order still has to be created, exactly once).
  | { kind: 'paid' }
  // Live again: REQUIRES_CUSTOMER_ACTION (nothing received; the customer
  // may finish it on the same intent).
  | { kind: 'waiting' }
  // AWAITING_CONFIRMATION (held).
  | { kind: 'processing' }
  // FAILED: cancelled with nothing received; the holds are released.
  | { kind: 'not-charged' }
  // A different amount or currency taken: held for people.
  | { kind: 'mismatch' }
  // Stripe could not be read, or its answer proves nothing: unchanged.
  | { kind: 'unreadable' }
  // Moved meanwhile by something else: the caller re-reads it.
  | { kind: 'changed' };

export type Replay =
  | { kind: 'linked'; reference: string }
  // Outside the safe window: never replayed (people must look).
  | { kind: 'expired' }
  // Stripe refuses the key with these parameters, or the intent it names
  // already belongs to another payment: people must look.
  | { kind: 'conflict' }
  // No account was recorded with the claim: nothing to replay on.
  | { kind: 'no-account' }
  | { kind: 'unreadable' }
  | { kind: 'changed' };

const TIMEOUT = Symbol('provider-timeout');

async function bounded<T>(
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

function isHeld(state: string | null): state is HeldState {
  return (RECOVERABLE_HELD_STATES as readonly string[]).includes(state ?? '');
}

// Replays the original creation of a held payment that never recorded its
// intent. Within the window only; the same key, account and parameters.
export async function replayPaymentIntentCreation(
  prisma: PrismaService,
  provider: PaymentIntentProvider,
  payment: HeldPayment & { providerAccountId: string | null },
  account: PaymentAccountContext,
  now: Date = new Date(),
  timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
): Promise<Replay> {
  if (!isHeld(payment.paymentState) || payment.providerReference !== null) {
    return { kind: 'changed' };
  }
  if (
    payment.providerAccountId === null ||
    account.connectedAccountId !== payment.providerAccountId
  ) {
    return { kind: 'no-account' };
  }
  if (
    now.getTime() - payment.createdAt.getTime() >=
    STRIPE_CREATE_REPLAY_WINDOW_MS
  ) {
    return { kind: 'expired' };
  }
  let result: PaymentIntentResult;
  try {
    const answer = await bounded(
      () =>
        provider.createPaymentIntent({
          idempotencyKey: payment.idempotencyKey,
          ...intentCreationInput(payment, account),
        }),
      timeoutMs,
    );
    if (answer === TIMEOUT) return { kind: 'unreadable' };
    result = answer;
  } catch {
    return { kind: 'unreadable' };
  }
  if (result.status === 'failed') {
    // A LOCAL refusal now (e.g. the business left the allowlist) says
    // nothing about the ORIGINAL request, which may have reached Stripe.
    return { kind: 'unreadable' };
  }
  if (result.status === 'unknown') {
    if (result.reference) {
      // Stripe named an intent that is not what this payment asked for (a
      // different amount or currency, live mode): never linked — people
      // must look.
      return { kind: 'conflict' };
    }
    return isIdempotencyMismatch(result.reason)
      ? { kind: 'conflict' }
      : { kind: 'unreadable' };
  }
  const reference = result.reference;
  try {
    const linked = await prisma.paymentAttempt.updateMany({
      where: {
        id: payment.id,
        tenantId: payment.tenantId,
        provider: 'stripe',
        status: 'PENDING',
        paymentState: payment.paymentState,
        providerReference: null,
        providerAccountId: payment.providerAccountId,
      },
      data: { providerReference: reference },
    });
    if (linked.count === 1) {
      await noteOnCase(prisma, payment.tenantId, payment.id, {
        action: 'STRIPE_INTENT_LINKED',
        from: payment.paymentState,
        to: payment.paymentState,
      });
      return { kind: 'linked', reference };
    }
  } catch (error) {
    // The intent already names another payment (one Stripe payment per
    // intent, unique index): never linked twice.
    if (isUniqueViolation(error)) return { kind: 'conflict' };
    throw error;
  }
  const now2 = await prisma.paymentAttempt.findFirst({
    where: { id: payment.id, tenantId: payment.tenantId },
    select: { providerReference: true },
  });
  return now2?.providerReference === reference
    ? { kind: 'linked', reference }
    : { kind: 'changed' };
}

// Reads a held payment's intent back from Stripe and moves it on Stripe's
// definitive answer only.
export async function readBackHeldPayment(
  prisma: PrismaService,
  provider: PaymentIntentProvider,
  payment: HeldPayment & { providerReference: string },
  account: PaymentAccountContext,
  timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
): Promise<ReadBack> {
  if (!isHeld(payment.paymentState)) return { kind: 'changed' };
  const from = payment.paymentState;
  let result: PaymentIntentResult;
  try {
    const answer = await bounded(
      () =>
        provider.retrievePaymentIntent({
          reference: payment.providerReference,
          account,
        }),
      timeoutMs,
    );
    if (answer === TIMEOUT) return { kind: 'unreadable' };
    result = answer;
  } catch {
    return { kind: 'unreadable' };
  }
  if (
    result.status === 'failed' ||
    result.status === 'unknown' ||
    result.reference !== payment.providerReference
  ) {
    return { kind: 'unreadable' };
  }
  // Exactly the state and intent that were read.
  const exact = {
    id: payment.id,
    tenantId: payment.tenantId,
    provider: 'stripe',
    status: 'PENDING' as const,
    paymentState: from,
    providerReference: payment.providerReference,
  };
  const move = async (
    data: Record<string, unknown>,
    to: string,
    kind: 'paid' | 'waiting' | 'processing',
  ): Promise<ReadBack> => {
    const moved = await prisma.paymentAttempt.updateMany({
      where: exact,
      data,
    });
    if (moved.count !== 1) return { kind: 'changed' };
    await noteOnCase(prisma, payment.tenantId, payment.id, {
      action: 'STRIPE_OUTCOME_RECOVERED',
      from,
      to,
    });
    return { kind };
  };
  // An intent that is not final but FOR another amount or currency is never
  // made live again or held as processing: held for people.
  if (
    (result.status === 'requires_customer_action' ||
      result.status === 'requires_payment_method' ||
      result.status === 'processing') &&
    ((result.amount !== undefined && result.amount !== payment.amount) ||
      (result.currency !== undefined &&
        result.currency.toUpperCase() !== payment.currency.toUpperCase()))
  ) {
    await openReconciliationCase(
      prisma,
      payment.id,
      'PROVIDER_AMOUNT_MISMATCH',
      { outcome: 'unknown' },
    );
    return { kind: 'mismatch' };
  }
  switch (result.status) {
    case 'succeeded': {
      if (
        result.amount !== payment.amount ||
        result.currency.toUpperCase() !== payment.currency.toUpperCase()
      ) {
        await openReconciliationCase(
          prisma,
          payment.id,
          'PROVIDER_AMOUNT_MISMATCH',
          { outcome: 'unknown' },
        );
        return { kind: 'mismatch' };
      }
      return move(
        { status: 'SUCCEEDED', paymentState: 'SUCCEEDED', failureReason: null },
        'SUCCEEDED',
        'paid',
      );
    }
    case 'processing':
      if (from === 'AWAITING_CONFIRMATION') return { kind: 'processing' };
      return move(
        {
          paymentState: 'AWAITING_CONFIRMATION',
          failureReason: 'The payment provider is processing the payment.',
        },
        'AWAITING_CONFIRMATION',
        'processing',
      );
    case 'requires_customer_action':
    case 'requires_payment_method':
      // Nothing received (the adapter refuses any intent that is not
      // succeeded yet has money received): live again on the same intent.
      return move(
        { paymentState: 'REQUIRES_CUSTOMER_ACTION', failureReason: null },
        'REQUIRES_CUSTOMER_ACTION',
        'waiting',
      );
    case 'canceled': {
      // Cancelled with nothing received (checked by the adapter): no charge
      // can occur. FAILED releases the holds in the same statement; an open
      // case resolves as NOT_CHARGED with it.
      const closed = await prisma.$transaction(async (tx) => {
        const moved = await tx.paymentAttempt.updateMany({
          where: exact,
          data: {
            status: 'FAILED',
            paymentState: 'FAILED',
            failureReason: 'The payment intent was cancelled.',
          },
        });
        if (moved.count === 1) {
          await resolveCaseAsNotCharged(tx, payment.tenantId, payment.id);
        }
        return moved.count;
      });
      return closed === 1 ? { kind: 'not-charged' } : { kind: 'changed' };
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
