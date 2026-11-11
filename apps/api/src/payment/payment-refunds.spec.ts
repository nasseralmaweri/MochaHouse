import {
  PAYMENT_REFUND_STATUSES,
  REFUND_IDEMPOTENCY_WINDOW_MS,
  canMoveRefund,
  notCreatedEvidenceFor,
  obligationStanding,
  refundIdempotencyKey,
  summarizeRefunds,
  transitionFor,
  type PaymentRefundStatus,
  type RefundRow,
} from './payment-refunds';

// ESP-04 M5a — the refund rules as plain functions (no database, no Stripe).

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
      settleable: false,
      needsAttention: true,
    });
  });

  it('a settled obligation whose money came back is never presented as satisfied: owed again and flagged', () => {
    // Settled on a refund that has since come back, and was reviewed.
    const returned = row('FAILED_AFTER_SUCCESS', 1000, {
      lateFailureReviewedAt: new Date(),
    });
    expect(obligationStanding(1000, [returned], 'REFUNDED')).toEqual({
      obligationMinorUnits: 1000,
      refundedMinorUnits: 0,
      inProgressMinorUnits: 0,
      outstandingMinorUnits: 1000,
      fullyRefunded: false,
      settleable: false,
      needsAttention: true,
    });
    // A replacement that succeeded covers it again.
    expect(
      obligationStanding(1000, [returned, row('SUCCEEDED', 1000)], 'REFUNDED'),
    ).toMatchObject({ fullyRefunded: true, needsAttention: false });
  });

  it('a fully refunded obligation is settleable at once, but never while a returned refund is unreviewed', () => {
    const covered = [row('SUCCEEDED', 1000)];
    expect(obligationStanding(1000, covered)).toMatchObject({
      fullyRefunded: true,
      settleable: true,
      needsAttention: false,
    });
    const withUnreviewed = [
      ...covered,
      row('FAILED_AFTER_SUCCESS', 1000, { origin: 'EXTERNAL' }),
    ];
    expect(obligationStanding(1000, withUnreviewed)).toMatchObject({
      fullyRefunded: true,
      settleable: false,
      needsAttention: true,
    });
  });

  it('"never created" needs proof: never sent, or a complete Stripe history past the window showing nothing that could be it', () => {
    const sent = new Date('2026-11-01T00:00:00Z');
    const later = (ms: number) => new Date(sent.getTime() + ms);
    const base = {
      refundId: 'rf-1',
      amountMinorUnits: 500,
      firstSentAt: sent,
      now: later(REFUND_IDEMPOTENCY_WINDOW_MS + 1000),
      listed: { refunds: [], complete: true },
      recordedProviderRefundIds: new Set<string>(),
    };
    expect(notCreatedEvidenceFor({ ...base, firstSentAt: null })).toBe(
      'NEVER_SENT',
    );
    expect(notCreatedEvidenceFor(base)).toBe('STRIPE_HISTORY_VERIFIED');
    // Inside the idempotency window: proves nothing yet.
    expect(notCreatedEvidenceFor({ ...base, now: later(60_000) })).toBeNull();
    // Stripe unreadable, or not every page read.
    expect(notCreatedEvidenceFor({ ...base, listed: null })).toBeNull();
    expect(
      notCreatedEvidenceFor({
        ...base,
        listed: { refunds: [], complete: false },
      }),
    ).toBeNull();
    // It exists.
    const ours = {
      providerRefundId: 're_1',
      amountMinorUnits: 500,
      centerivoRefundId: 'rf-1',
    };
    expect(
      notCreatedEvidenceFor({
        ...base,
        listed: { refunds: [ours], complete: true },
      }),
    ).toBeNull();
    // An unrecorded refund of the same amount without our id might be it.
    const lookalike = {
      providerRefundId: 're_2',
      amountMinorUnits: 500,
      centerivoRefundId: null,
    };
    expect(
      notCreatedEvidenceFor({
        ...base,
        listed: { refunds: [lookalike], complete: true },
      }),
    ).toBeNull();
    // ...unless it is already recorded (a known Dashboard refund), or is
    // another operation's, or another amount.
    expect(
      notCreatedEvidenceFor({
        ...base,
        listed: { refunds: [lookalike], complete: true },
        recordedProviderRefundIds: new Set(['re_2']),
      }),
    ).toBe('STRIPE_HISTORY_VERIFIED');
    expect(
      notCreatedEvidenceFor({
        ...base,
        listed: {
          refunds: [
            { ...ours, centerivoRefundId: 'rf-other' },
            { ...lookalike, amountMinorUnits: 300 },
          ],
          complete: true,
        },
      }),
    ).toBe('STRIPE_HISTORY_VERIFIED');
  });

  it('an obligation partly covered by a Dashboard refund owes only the rest, and is never fully refunded until all of it is', () => {
    const external = row('SUCCEEDED', 300, { origin: 'EXTERNAL' });
    expect(obligationStanding(1000, [external])).toEqual({
      obligationMinorUnits: 1000,
      refundedMinorUnits: 300,
      inProgressMinorUnits: 0,
      outstandingMinorUnits: 700,
      fullyRefunded: false,
      settleable: false,
      needsAttention: false,
    });
    // The rest asked for: nothing more outstanding, still not fully refunded.
    expect(
      obligationStanding(1000, [external, row('PENDING', 700)]),
    ).toMatchObject({
      outstandingMinorUnits: 0,
      inProgressMinorUnits: 700,
      fullyRefunded: false,
    });
    // All of it succeeded: settleable now (no waiting period).
    expect(
      obligationStanding(1000, [external, row('SUCCEEDED', 700)]),
    ).toMatchObject({
      refundedMinorUnits: 1000,
      outstandingMinorUnits: 0,
      fullyRefunded: true,
      settleable: true,
    });
  });

  it("derives the Stripe key from the operation's own id, and refuses without one", () => {
    expect(refundIdempotencyKey('01a0db02-f800-7000-8000-0000000000aa')).toBe(
      'centerivo-refund:01a0db02-f800-7000-8000-0000000000aa',
    );
    expect(() => refundIdempotencyKey('')).toThrow();
    expect(() => refundIdempotencyKey('a b')).toThrow();
  });
});
