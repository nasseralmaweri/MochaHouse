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
//   * an obligation may be recorded settled once Stripe's read-back shows
//     succeeded refunds covering all of it, none still in flight, and no
//     returned refund unreviewed;
//   * a refund whose money came back (FAILED_AFTER_SUCCESS) — even after
//     settlement — is owed again, flagged for people, and blocks any new
//     CENTERIVO refund of the payment until a staff member has reviewed it;
//   * "never created" needs proof (notCreatedEvidenceFor), never a timeout.

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

export interface ObligationStanding {
  obligationMinorUnits: number;
  // Refunded and confirmed by Stripe (as the refunds stand NOW: a refund
  // whose money came back no longer counts).
  refundedMinorUnits: number;
  // On its way (waiting for Stripe's answer).
  inProgressMinorUnits: number;
  // Still owed to the customer and not yet asked for: what a new refund
  // for this obligation may be for (never the whole obligation again).
  outstandingMinorUnits: number;
  // Succeeded refunds cover all of it and nothing is in flight.
  fullyRefunded: boolean;
  // It may be recorded as settled now: fully refunded, and no returned
  // refund waits for its review (the database's settlement rule).
  settleable: boolean;
  // People must look: a returned refund is unreviewed, or the obligation
  // was recorded settled but its refunds no longer cover it (money came
  // back afterwards). Never presented to anyone as satisfied.
  needsAttention: boolean;
}

// Where an order's refund obligation stands, from the refunds of its
// payment (every refund of that payment counts towards it). The
// obligation's recorded status is only used to flag a settled obligation
// whose money came back: what is owed always comes from the refunds.
export function obligationStanding(
  obligationMinorUnits: number,
  refunds: readonly RefundRow[],
  recordedStatus?: string,
): ObligationStanding {
  const summary = summarizeRefunds(obligationMinorUnits, refunds);
  const fullyRefunded =
    summary.succeededMinorUnits >= obligationMinorUnits &&
    summary.inFlightMinorUnits === 0;
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
    settleable: fullyRefunded && !summary.lateFailureNeedsReview,
    needsAttention:
      summary.lateFailureNeedsReview ||
      (recordedStatus === 'REFUNDED' && !fullyRefunded),
  };
}

// --- "Never created" needs proof -------------------------------------------
//
// NOT_CREATED gives a refund's reserved amount back, so it is never inferred
// from a timeout, an error or time passing. The evidence the database
// accepts (PaymentRefund.notCreatedEvidence):
//   NEVER_SENT               the request was never sent to Stripe;
//   STRIPE_HISTORY_VERIFIED  it was sent, and a COMPLETE read-back of the
//                            payment's refunds at Stripe (on its own account),
//                            made past the idempotency window, shows no refund
//                            of this operation — and nothing that might be it.
export type NotCreatedEvidence = 'NEVER_SENT' | 'STRIPE_HISTORY_VERIFIED';

// Stripe keeps idempotency keys for at least 24 hours: before that, the same
// key could still bring the refund back, so absence proves nothing yet (the
// database enforces the same window).
export const REFUND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ListedRefund {
  providerRefundId: string;
  amountMinorUnits: number;
  centerivoRefundId: string | null;
}

// The evidence for recording a refund operation as never created, or null
// when its absence is not conclusively proven (it then stays UNKNOWN, its
// amount reserved). `listed` is the read-back of the payment's refunds:
// null when it could not be read; `complete` false when not every page was
// read.
export function notCreatedEvidenceFor(input: {
  refundId: string;
  amountMinorUnits: number;
  firstSentAt: Date | null;
  now: Date;
  listed: { refunds: readonly ListedRefund[]; complete: boolean } | null;
  // Stripe refund ids already recorded for this payment (any origin):
  // a listed refund we already know is accounted for.
  recordedProviderRefundIds: ReadonlySet<string>;
}): NotCreatedEvidence | null {
  if (input.firstSentAt === null) return 'NEVER_SENT';
  if (
    input.now.getTime() - input.firstSentAt.getTime() <
    REFUND_IDEMPOTENCY_WINDOW_MS
  ) {
    return null;
  }
  if (input.listed === null || !input.listed.complete) return null;
  for (const refund of input.listed.refunds) {
    // It exists: never "not created".
    if (refund.centerivoRefundId === input.refundId) return null;
    // A refund of this payment we have not recorded, for the same amount,
    // carrying no CENTERIVO id: it might be this one. Not conclusive.
    if (
      refund.centerivoRefundId === null &&
      refund.amountMinorUnits === input.amountMinorUnits &&
      !input.recordedProviderRefundIds.has(refund.providerRefundId)
    ) {
      return null;
    }
  }
  return 'STRIPE_HISTORY_VERIFIED';
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
