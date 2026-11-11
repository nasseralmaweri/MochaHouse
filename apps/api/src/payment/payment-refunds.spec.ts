import {
  PAYMENT_REFUND_STATUSES,
  SETTLEMENT_HOLD_DAYS,
  canMoveRefund,
  obligationStanding,
  refundIdempotencyKey,
  summarizeRefunds,
  transitionFor,
  type PaymentRefundStatus,
  type RefundRow,
} from './payment-refunds';

// ESP-04 M5a — the refund rules as plain functions (no database, no Stripe).

const DAY = 24 * 60 * 60 * 1000;
const row = (
  status: PaymentRefundStatus,
  amountMinorUnits: number,
  over: Partial<RefundRow> = {},
): RefundRow => ({
  status,
  amountMinorUnits,
  origin: 'CENTERIVO',
  succeededAt:
    status === 'SUCCEEDED' || status === 'FAILED_AFTER_SUCCESS'
      ? new Date('2026-11-01T00:00:00Z')
      : null,
  lateFailureReviewedAt: null,
  ...over,
});

describe('ESP-04 M5a refund rules', () => {
  it('allows exactly the moves the database allows', () => {
    const allowed = new Set([
      'REQUESTED>PENDING',
      'REQUESTED>SUCCEEDED',
      'REQUESTED>FAILED',
      'REQUESTED>CANCELED',
      'REQUESTED>UNKNOWN',
      'REQUESTED>NOT_CREATED',
      'UNKNOWN>PENDING',
      'UNKNOWN>SUCCEEDED',
      'UNKNOWN>FAILED',
      'UNKNOWN>CANCELED',
      'UNKNOWN>NOT_CREATED',
      'PENDING>SUCCEEDED',
      'PENDING>FAILED',
      'PENDING>CANCELED',
      'SUCCEEDED>FAILED_AFTER_SUCCESS',
    ]);
    for (const from of PAYMENT_REFUND_STATUSES) {
      for (const to of PAYMENT_REFUND_STATUSES) {
        expect([`${from}>${to}`, canMoveRefund(from, to)]).toEqual([
          `${from}>${to}`,
          allowed.has(`${from}>${to}`),
        ]);
      }
    }
  });

  it('moves a refund only on what Stripe reports, and flags what it cannot follow', () => {
    expect(transitionFor('REQUESTED', 'unknown')).toEqual({ kind: 'stay' });
    expect(transitionFor('REQUESTED', 'pending')).toEqual({
      kind: 'move',
      to: 'PENDING',
    });
    expect(transitionFor('UNKNOWN', 'requires_action')).toEqual({
      kind: 'move',
      to: 'PENDING',
    });
    expect(transitionFor('PENDING', 'pending')).toEqual({ kind: 'stay' });
    expect(transitionFor('UNKNOWN', 'succeeded')).toEqual({
      kind: 'move',
      to: 'SUCCEEDED',
    });
    expect(transitionFor('PENDING', 'failed')).toEqual({
      kind: 'move',
      to: 'FAILED',
    });
    expect(transitionFor('REQUESTED', 'canceled')).toEqual({
      kind: 'move',
      to: 'CANCELED',
    });
    // The money came back after success (a failure or a cancellation).
    expect(transitionFor('SUCCEEDED', 'failed')).toEqual({
      kind: 'move',
      to: 'FAILED_AFTER_SUCCESS',
    });
    expect(transitionFor('SUCCEEDED', 'canceled')).toEqual({
      kind: 'move',
      to: 'FAILED_AFTER_SUCCESS',
    });
    expect(transitionFor('SUCCEEDED', 'succeeded')).toEqual({ kind: 'stay' });
    expect(transitionFor('FAILED_AFTER_SUCCESS', 'failed')).toEqual({
      kind: 'stay',
    });
    // Never written: a failed refund that now succeeded, a settled one
    // going back to pending, a "never created" one Stripe has.
    expect(transitionFor('FAILED', 'succeeded').kind).toBe('anomaly');
    expect(transitionFor('SUCCEEDED', 'pending').kind).toBe('anomaly');
    expect(transitionFor('NOT_CREATED', 'succeeded').kind).toBe('anomaly');
    expect(transitionFor('CANCELED', 'failed').kind).toBe('anomaly');
    // Every move it proposes is one the database allows.
    for (const from of PAYMENT_REFUND_STATUSES) {
      for (const observed of [
        'pending',
        'requires_action',
        'succeeded',
        'failed',
        'canceled',
        'unknown',
      ] as const) {
        const t = transitionFor(from, observed);
        if (t.kind === 'move') expect(canMoveRefund(from, t.to)).toBe(true);
      }
    }
  });

  it('counts every refund against the charge until it is proven not to have happened or came back', () => {
    const summary = summarizeRefunds(1000, [
      row('SUCCEEDED', 200),
      row('PENDING', 100),
      row('UNKNOWN', 50),
      row('REQUESTED', 25),
      row('FAILED', 400),
      row('CANCELED', 400),
      row('NOT_CREATED', 400),
      row('SUCCEEDED', 100, { origin: 'EXTERNAL' }),
    ]);
    expect(summary).toEqual({
      chargedMinorUnits: 1000,
      succeededMinorUnits: 300,
      inFlightMinorUnits: 175,
      reservedMinorUnits: 475,
      refundableMinorUnits: 525,
      returnedAfterSuccessMinorUnits: 0,
      lateFailureNeedsReview: false,
      overReserved: false,
    });
  });

  it('a late failure gives the amount back, is owed again, and needs review until reviewed', () => {
    const late = row('FAILED_AFTER_SUCCESS', 1000);
    expect(summarizeRefunds(1000, [late])).toMatchObject({
      succeededMinorUnits: 0,
      refundableMinorUnits: 1000,
      returnedAfterSuccessMinorUnits: 1000,
      lateFailureNeedsReview: true,
    });
    expect(
      summarizeRefunds(1000, [{ ...late, lateFailureReviewedAt: new Date() }])
        .lateFailureNeedsReview,
    ).toBe(false);
    expect(obligationStanding(1000, [late])).toMatchObject({
      refundedMinorUnits: 0,
      outstandingMinorUnits: 1000,
      fullyRefunded: false,
      settleableFrom: null,
    });
  });

  it('an obligation partly covered by a Dashboard refund owes only the rest, and is never fully refunded until all of it is', () => {
    const external = row('SUCCEEDED', 300, { origin: 'EXTERNAL' });
    expect(obligationStanding(1000, [external])).toEqual({
      obligationMinorUnits: 1000,
      refundedMinorUnits: 300,
      inProgressMinorUnits: 0,
      outstandingMinorUnits: 700,
      fullyRefunded: false,
      settleableFrom: null,
    });
    // The rest asked for: nothing more outstanding, still not fully refunded.
    expect(
      obligationStanding(1000, [external, row('PENDING', 700)]),
    ).toMatchObject({
      outstandingMinorUnits: 0,
      inProgressMinorUnits: 700,
      fullyRefunded: false,
    });
    // All of it succeeded: settleable once the hold has passed.
    const last = new Date('2026-11-05T00:00:00Z');
    const standing = obligationStanding(1000, [
      external,
      row('SUCCEEDED', 700, { succeededAt: last }),
    ]);
    expect(standing).toMatchObject({
      refundedMinorUnits: 1000,
      outstandingMinorUnits: 0,
      fullyRefunded: true,
    });
    expect(standing.settleableFrom?.getTime()).toBe(
      last.getTime() + SETTLEMENT_HOLD_DAYS * DAY,
    );
  });

  it("derives the Stripe key from the operation's own id, and refuses without one", () => {
    expect(refundIdempotencyKey('01a0db02-f800-7000-8000-0000000000aa')).toBe(
      'centerivo-refund:01a0db02-f800-7000-8000-0000000000aa',
    );
    expect(() => refundIdempotencyKey('')).toThrow();
    expect(() => refundIdempotencyKey('a b')).toThrow();
  });
});
