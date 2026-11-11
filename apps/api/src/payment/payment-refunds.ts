// ESP-04 M5a — the refund rules as plain functions: the vocabulary of a
// payment refund, how a Stripe answer moves it, and what is left to refund
// and still owed. They MIRROR the database guards of migration
// 20261124090000_payment_refunds (which stay the final authority): nothing
// here writes anything, calls Stripe or decides who may refund.
//
// Money rules (owner decisions for M5, with the M5a clarifications):
//   * every refund of a payment counts against what was charged, wherever it
//     was made (CENTERIVO or the restaurant's Stripe Dashboard), until it is
//     proven not to have happened or its money came back;
//   * an order's refund obligation is for its whole card-paid amount, so
//     every refund of its payment counts towards it: what is still owed is
//     the obligation minus those refunds, never the whole obligation again;
//   * an obligation is satisfied only when succeeded refunds cover all of
//     it, none is still in flight, and the last succeeded at least
//     SETTLEMENT_HOLD_DAYS ago (Stripe can return a card refund later);
//   * a refund whose money came back (FAILED_AFTER_SUCCESS) is owed again,
//     and blocks any new CENTERIVO refund of the payment until a staff member
//     has reviewed it.

export const PAYMENT_REFUND_STATUSES = [
  'REQUESTED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'UNKNOWN',
  'NOT_CREATED',
  'FAILED_AFTER_SUCCESS',
] as const;
export type PaymentRefundStatus = (typeof PAYMENT_REFUND_STATUSES)[number];

export type PaymentRefundOrigin = 'CENTERIVO' | 'EXTERNAL';

// Count against what is left to refund (the database's capacity rule).
export const RESERVING_REFUND_STATUSES: ReadonlySet<PaymentRefundStatus> =
  new Set(['REQUESTED', 'PENDING', 'UNKNOWN', 'SUCCEEDED']);
// Still waiting for an answer: an order is not closed, and an obligation is
// not settled, while one exists.
export const IN_FLIGHT_REFUND_STATUSES: ReadonlySet<PaymentRefundStatus> =
  new Set(['REQUESTED', 'PENDING', 'UNKNOWN']);

// The moves the database allows (PaymentRefund_guard).
const ALLOWED_MOVES: ReadonlyMap<
  PaymentRefundStatus,
  ReadonlySet<PaymentRefundStatus>
> = new Map<PaymentRefundStatus, ReadonlySet<PaymentRefundStatus>>([
  [
    'REQUESTED',
    new Set<PaymentRefundStatus>([
      'PENDING',
      'SUCCEEDED',
      'FAILED',
      'CANCELED',
      'UNKNOWN',
      'NOT_CREATED',
    ]),
  ],
  [
    'UNKNOWN',
    new Set<PaymentRefundStatus>([
      'PENDING',
      'SUCCEEDED',
      'FAILED',
      'CANCELED',
      'NOT_CREATED',
    ]),
  ],
  [
    'PENDING',
    new Set<PaymentRefundStatus>(['SUCCEEDED', 'FAILED', 'CANCELED']),
  ],
  ['SUCCEEDED', new Set<PaymentRefundStatus>(['FAILED_AFTER_SUCCESS'])],
  ['FAILED', new Set<PaymentRefundStatus>()],
  ['CANCELED', new Set<PaymentRefundStatus>()],
  ['NOT_CREATED', new Set<PaymentRefundStatus>()],
  ['FAILED_AFTER_SUCCESS', new Set<PaymentRefundStatus>()],
]);

export function canMoveRefund(
  from: PaymentRefundStatus,
  to: PaymentRefundStatus,
): boolean {
  return ALLOWED_MOVES.get(from)?.has(to) ?? false;
}

// Stripe's word for a refund, as the adapter reports it ('unknown' when the
// answer could not be read or named something else).
export type StripeRefundState =
  | 'pending'
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'unknown';

export type RefundTransition =
  // Move the refund to this status (allowed by the database).
  | { kind: 'move'; to: PaymentRefundStatus }
  // Nothing to change.
  | { kind: 'stay' }
  // Stripe reports something our record cannot follow (for example a
  // failed refund now succeeded): never written, always for people.
  | { kind: 'anomaly'; reason: string };

// What a Stripe read-back of a refund means for our record of it. Only ever
// fed by a read-back from Stripe on the payment's own account.
export function transitionFor(
  current: PaymentRefundStatus,
  observed: StripeRefundState,
): RefundTransition {
  if (observed === 'unknown') return { kind: 'stay' };
  const waiting =
    current === 'REQUESTED' || current === 'UNKNOWN' || current === 'PENDING';
  switch (observed) {
    case 'pending':
    case 'requires_action':
      if (current === 'PENDING') return { kind: 'stay' };
      if (waiting) return { kind: 'move', to: 'PENDING' };
      return anomaly(current, observed);
    case 'succeeded':
      if (current === 'SUCCEEDED') return { kind: 'stay' };
      if (waiting) return { kind: 'move', to: 'SUCCEEDED' };
      return anomaly(current, observed);
    case 'failed':
    case 'canceled':
      if (waiting) {
        return {
          kind: 'move',
          to: observed === 'failed' ? 'FAILED' : 'CANCELED',
        };
      }
      // It succeeded, and its money has come back since.
      if (current === 'SUCCEEDED') {
        return { kind: 'move', to: 'FAILED_AFTER_SUCCESS' };
      }
      if (
        current === 'FAILED_AFTER_SUCCESS' ||
        (current === 'FAILED' && observed === 'failed') ||
        (current === 'CANCELED' && observed === 'canceled')
      ) {
        return { kind: 'stay' };
      }
      return anomaly(current, observed);
  }
}

function anomaly(
  current: PaymentRefundStatus,
  observed: StripeRefundState,
): RefundTransition {
  return {
    kind: 'anomaly',
    reason: `recorded ${current}, Stripe reports ${observed}`,
  };
}

export interface RefundRow {
  status: PaymentRefundStatus;
  amountMinorUnits: number;
  origin: PaymentRefundOrigin;
  succeededAt: Date | null;
  lateFailureReviewedAt: Date | null;
}

export interface RefundSummary {
  // What the payment charged.
  chargedMinorUnits: number;
  // Refunds Stripe reports as succeeded.
  succeededMinorUnits: number;
  // Refunds still waiting for an answer (REQUESTED, PENDING, UNKNOWN).
  inFlightMinorUnits: number;
  // Everything counted against the charge (in flight + succeeded).
  reservedMinorUnits: number;
  // What a new CENTERIVO refund may still take (never below zero).
  refundableMinorUnits: number;
  // Refunds that succeeded and then came back.
  returnedAfterSuccessMinorUnits: number;
  // A refund came back and nobody has reviewed it yet: no new CENTERIVO
  // refund until someone does.
  lateFailureNeedsReview: boolean;
  // More is counted than was charged (a CENTERIVO request still unanswered
  // alongside a refund made in the Dashboard): one of them cannot have
  // happened, and people must look.
  overReserved: boolean;
}

export function summarizeRefunds(
  chargedMinorUnits: number,
  refunds: readonly RefundRow[],
): RefundSummary {
  let succeeded = 0;
  let inFlight = 0;
  let returned = 0;
  let needsReview = false;
  for (const refund of refunds) {
    if (refund.status === 'SUCCEEDED') succeeded += refund.amountMinorUnits;
    else if (IN_FLIGHT_REFUND_STATUSES.has(refund.status)) {
      inFlight += refund.amountMinorUnits;
    } else if (refund.status === 'FAILED_AFTER_SUCCESS') {
      returned += refund.amountMinorUnits;
      if (refund.lateFailureReviewedAt === null) needsReview = true;
    }
  }
  const reserved = succeeded + inFlight;
  return {
    chargedMinorUnits,
    succeededMinorUnits: succeeded,
    inFlightMinorUnits: inFlight,
    reservedMinorUnits: reserved,
    refundableMinorUnits: Math.max(0, chargedMinorUnits - reserved),
    returnedAfterSuccessMinorUnits: returned,
    lateFailureNeedsReview: needsReview,
    overReserved: reserved > chargedMinorUnits,
  };
}

// Stripe can return a card refund up to 30 days after it succeeded; an
// obligation is not recorded as settled before then (the database enforces
// the same number).
export const SETTLEMENT_HOLD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ObligationStanding {
  obligationMinorUnits: number;
  // Refunded and confirmed by Stripe.
  refundedMinorUnits: number;
  // On its way (waiting for Stripe's answer).
  inProgressMinorUnits: number;
  // Still owed to the customer and not yet asked for: what a new refund
  // for this obligation may be for (never the whole obligation again).
  outstandingMinorUnits: number;
  // Succeeded refunds cover all of it and nothing is in flight.
  fullyRefunded: boolean;
  // When it may be recorded as settled (fully refunded, and the hold has
  // passed); null while it is not fully refunded.
  settleableFrom: Date | null;
}

// Where an order's refund obligation stands, from the refunds of its
// payment (every refund of that payment counts towards it).
export function obligationStanding(
  obligationMinorUnits: number,
  refunds: readonly RefundRow[],
): ObligationStanding {
  const summary = summarizeRefunds(obligationMinorUnits, refunds);
  const fullyRefunded =
    summary.succeededMinorUnits >= obligationMinorUnits &&
    summary.inFlightMinorUnits === 0;
  let settleableFrom: Date | null = null;
  if (fullyRefunded) {
    const latest = Math.max(
      ...refunds
        .filter((r) => r.status === 'SUCCEEDED' && r.succeededAt !== null)
        .map((r) => r.succeededAt!.getTime()),
    );
    settleableFrom = new Date(latest + SETTLEMENT_HOLD_DAYS * DAY_MS);
  }
  return {
    obligationMinorUnits,
    refundedMinorUnits: Math.min(
      summary.succeededMinorUnits,
      obligationMinorUnits,
    ),
    inProgressMinorUnits: summary.inFlightMinorUnits,
    outstandingMinorUnits: Math.max(
      0,
      obligationMinorUnits - summary.reservedMinorUnits,
    ),
    fullyRefunded,
    settleableFrom,
  };
}

// The Stripe idempotency key of ONE refund operation: derived from its own
// id, so every retry of that operation sends the same key and a new
// operation can never reuse an old one.
export function refundIdempotencyKey(refundId: string): string {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(refundId)) {
    throw new Error('A refund id is required for its idempotency key.');
  }
  return `centerivo-refund:${refundId}`;
}
