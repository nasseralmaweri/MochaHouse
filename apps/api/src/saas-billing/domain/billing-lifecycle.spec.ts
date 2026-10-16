import {
  billingAccess,
  decideSuspension,
  entitledToPlanModules,
  mayChargeAutomatically,
  transition,
  type BillingEvent,
  type BillingState,
  type TransitionResult,
} from './billing-lifecycle';

// SC3a — the pure billing lifecycle (owner decisions E3, E5–E8).
const T0 = new Date('2026-11-01T00:00:00Z');
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

function billed(over: Partial<BillingState> = {}): BillingState {
  return {
    billingMode: 'BILLED',
    status: 'ACTIVE',
    planVersionId: 'plan-v1',
    planPriceId: 'price-1',
    recurringPaymentAuthorizedAt: null,
    trialStartedAt: null,
    trialEndsAt: null,
    trialRequiresPaymentMethod: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    pastDueAt: null,
    graceEndsAt: null,
    recoveryEndsAt: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    pending: null,
    ...over,
  };
}

const authorized = (over: Partial<BillingState> = {}) =>
  billed({ recurringPaymentAuthorizedAt: T0, ...over });

function ok(result: TransitionResult) {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

const paid = (
  at: Date,
  reference = 'inv-1',
  periodStart = at,
  periodEnd = day(30),
  amountMinorUnits = 4900,
) =>
  ({
    type: 'PAYMENT_SUCCEEDED',
    at,
    reference,
    amountMinorUnits,
    currency: 'USD',
    periodStart,
    periodEnd,
  }) as const;
const failed = (at: Date, reference = 'inv-1', gracePeriodDays = 14) =>
  ({ type: 'PAYMENT_FAILED', at, reference, gracePeriodDays }) as const;

describe('SC3a billing lifecycle', () => {
  it('a COMPLIMENTARY (Founding) subscription refuses every billing event (E3)', () => {
    const founding = billed({
      billingMode: 'COMPLIMENTARY',
      planPriceId: null,
    });
    const events: BillingEvent[] = [
      { type: 'PAYMENT_AUTHORIZED', at: T0 },
      paid(T0),
      failed(T0),
      {
        type: 'TRIAL_STARTED',
        at: T0,
        trialDays: 14,
        requiresPaymentMethod: false,
      },
      { type: 'TRIAL_ENDED', at: T0, trialRecoveryDays: 3 },
      { type: 'GRACE_EXPIRED', at: T0 },
      { type: 'CANCEL_SCHEDULED', at: T0 },
      { type: 'SUBSCRIPTION_ENDED', at: T0, trialRecoveryDays: 3 },
    ];
    for (const event of events) {
      expect(transition(founding, event)).toEqual({
        ok: false,
        reason: 'COMPLIMENTARY',
      });
    }
    expect(mayChargeAutomatically(founding)).toBe(false);
    expect(billingAccess(founding)).toBe('FULL');
  });

  describe('trials (E5)', () => {
    it('starts one trial with the policy length, only before the first payment', () => {
      const r = ok(
        transition(billed(), {
          type: 'TRIAL_STARTED',
          at: T0,
          trialDays: 14,
          requiresPaymentMethod: false,
        }),
      );
      expect(r.next).toMatchObject({
        status: 'TRIALING',
        trialStartedAt: T0,
        trialEndsAt: day(14),
        trialRequiresPaymentMethod: false,
      });
      expect(r.history.map((h) => h.type)).toEqual(['TRIAL_STARTED']);

      expect(
        transition(r.next, {
          type: 'TRIAL_STARTED',
          at: day(1),
          trialDays: 14,
          requiresPaymentMethod: false,
        }),
      ).toEqual({ ok: false, reason: 'TRIAL_ALREADY_USED' });
      expect(
        transition(
          billed({ currentPeriodStart: T0, currentPeriodEnd: day(30) }),
          {
            type: 'TRIAL_STARTED',
            at: T0,
            trialDays: 14,
            requiresPaymentMethod: false,
          },
        ),
      ).toEqual({ ok: false, reason: 'NOT_CHANGEABLE' });
    });

    it('a trial that requires a payment method cannot start without authorization', () => {
      expect(
        transition(billed(), {
          type: 'TRIAL_STARTED',
          at: T0,
          trialDays: 14,
          requiresPaymentMethod: true,
        }),
      ).toEqual({ ok: false, reason: 'NOT_AUTHORIZED' });
      expect(
        ok(
          transition(authorized(), {
            type: 'TRIAL_STARTED',
            at: T0,
            trialDays: 14,
            requiresPaymentMethod: true,
          }),
        ).next.status,
      ).toBe('TRIALING');
    });

    it('a trial ending WITHOUT authorization expires and charges nothing', () => {
      const trialing = billed({
        status: 'TRIALING',
        trialStartedAt: T0,
        trialEndsAt: day(14),
        trialRequiresPaymentMethod: false,
      });
      const r = ok(
        transition(trialing, {
          type: 'TRIAL_ENDED',
          at: day(14),
          trialRecoveryDays: 3,
        }),
      );
      expect(r.next.status).toBe('TRIAL_EXPIRED');
      expect(r.history.map((h) => h.type)).toEqual(['TRIAL_EXPIRED']);
      // SC3c — not suspended yet: a recovery window first (core access
      // only; premium modules stop at once).
      expect(r.suspension).toBe('NONE');
      expect(r.next.recoveryEndsAt).toEqual(day(17));
      expect(entitledToPlanModules(r.next)).toBe(false);
      expect(mayChargeAutomatically(r.next)).toBe(false);
      expect(billingAccess(r.next)).toBe('BILLING_RECOVERY_ONLY');
      // The window ends: suspended for billing, still never charged.
      expect(
        transition(r.next, { type: 'RECOVERY_EXPIRED', at: day(16) }),
      ).toEqual({ ok: false, reason: 'RECOVERY_NOT_OVER' });
      const over = ok(
        transition(r.next, { type: 'RECOVERY_EXPIRED', at: day(17) }),
      );
      expect(over.suspension).toBe('SUSPEND_FOR_BILLING');
      expect(over.next).toMatchObject({
        status: 'TRIAL_EXPIRED',
        recoveryEndsAt: null,
      });
      // Only once.
      expect(
        transition(over.next, { type: 'RECOVERY_EXPIRED', at: day(18) }),
      ).toEqual({ ok: false, reason: 'NOT_IN_RECOVERY' });
      // An invalid window is refused rather than guessed.
      expect(
        transition(trialing, {
          type: 'TRIAL_ENDED',
          at: day(14),
          trialRecoveryDays: 0,
        }),
      ).toEqual({ ok: false, reason: 'NOT_CHANGEABLE' });
      // A failed charge against a business that never authorized one is not
      // a delinquency.
      expect(transition(trialing, failed(day(14)))).toEqual({
        ok: false,
        reason: 'NOT_AUTHORIZED',
      });
    });

    it('a trial ending WITH authorization waits for the first invoice', () => {
      const trialing = authorized({
        status: 'TRIALING',
        trialStartedAt: T0,
        trialEndsAt: day(14),
        trialRequiresPaymentMethod: true,
      });
      expect(
        ok(
          transition(trialing, {
            type: 'TRIAL_ENDED',
            at: day(14),
            trialRecoveryDays: 3,
          }),
        ).changed,
      ).toBe(false);
      expect(ok(transition(trialing, paid(day(14)))).next.status).toBe(
        'ACTIVE',
      );
      expect(ok(transition(trialing, failed(day(14)))).next.status).toBe(
        'PAST_DUE',
      );
    });

    it('nothing is ever charged automatically without recurring-payment authorization', () => {
      expect(mayChargeAutomatically(billed())).toBe(false);
      expect(mayChargeAutomatically(authorized())).toBe(true);
      expect(
        mayChargeAutomatically(
          authorized({ status: 'CANCELED', canceledAt: T0 }),
        ),
      ).toBe(false);
    });
  });

  describe('failed payments and grace (E6)', () => {
    it('the first failure starts ONE grace period; later failures never extend it', () => {
      const first = ok(transition(authorized(), failed(T0, 'inv-1', 14)));
      expect(first.next).toMatchObject({
        status: 'PAST_DUE',
        pastDueAt: T0,
        graceEndsAt: day(14),
      });
      expect(billingAccess(first.next)).toBe('FULL');

      const retry = ok(transition(first.next, failed(day(5), 'inv-1', 30)));
      expect(retry.next).toMatchObject({
        status: 'PAST_DUE',
        pastDueAt: T0,
        graceEndsAt: day(14),
      });
      expect(retry.history.map((h) => h.type)).toEqual(['PAYMENT_FAILED']);
    });

    it('grace expires only when it is over, then the business is suspended for billing', () => {
      const pastDue = authorized({
        status: 'PAST_DUE',
        pastDueAt: T0,
        graceEndsAt: day(14),
      });
      expect(
        transition(pastDue, { type: 'GRACE_EXPIRED', at: day(13) }),
      ).toEqual({
        ok: false,
        reason: 'GRACE_NOT_OVER',
      });
      const r = ok(transition(pastDue, { type: 'GRACE_EXPIRED', at: day(14) }));
      expect(r.next.status).toBe('UNPAID');
      expect(r.suspension).toBe('SUSPEND_FOR_BILLING');
      expect(billingAccess(r.next)).toBe('BILLING_RECOVERY_ONLY');
      expect(
        transition(authorized(), { type: 'GRACE_EXPIRED', at: day(20) }),
      ).toEqual({
        ok: false,
        reason: 'NOT_PAST_DUE',
      });
    });

    it('only a confirmed payment recovers, and it asks to lift a BILLING suspension', () => {
      const unpaid = authorized({
        status: 'UNPAID',
        pastDueAt: T0,
        graceEndsAt: day(14),
      });
      const r = ok(
        transition(unpaid, paid(day(20), 'inv-1', day(20), day(50))),
      );
      expect(r.next).toMatchObject({
        status: 'ACTIVE',
        pastDueAt: null,
        graceEndsAt: null,
      });
      expect(r.suspension).toBe('LIFT_BILLING_SUSPENSION');
      // Recovering within grace needs no lift.
      const pastDue = authorized({
        status: 'PAST_DUE',
        pastDueAt: T0,
        graceEndsAt: day(14),
      });
      expect(ok(transition(pastDue, paid(day(3)))).suspension).toBe('NONE');
    });

    it('billing never lifts a SECURITY or administrative suspension, and never re-suspends one', () => {
      expect(
        decideSuspension('LIFT_BILLING_SUSPENSION', {
          status: 'SUSPENDED',
          suspensionReason: 'BILLING',
        }),
      ).toBe('LIFT_BILLING');
      expect(
        decideSuspension('LIFT_BILLING_SUSPENSION', {
          status: 'SUSPENDED',
          suspensionReason: 'SECURITY',
        }),
      ).toBe('NONE');
      expect(
        decideSuspension('LIFT_BILLING_SUSPENSION', {
          status: 'SUSPENDED',
          suspensionReason: 'REQUESTED',
        }),
      ).toBe('NONE');
      expect(
        decideSuspension('LIFT_BILLING_SUSPENSION', {
          status: 'ACTIVE',
          suspensionReason: null,
        }),
      ).toBe('NONE');
      expect(
        decideSuspension('SUSPEND_FOR_BILLING', {
          status: 'ACTIVE',
          suspensionReason: null,
        }),
      ).toBe('SUSPEND_BILLING');
      expect(
        decideSuspension('SUSPEND_FOR_BILLING', {
          status: 'SUSPENDED',
          suspensionReason: 'SECURITY',
        }),
      ).toBe('NONE');
      expect(
        decideSuspension('NONE', { status: 'ACTIVE', suspensionReason: null }),
      ).toBe('NONE');
    });
  });

  describe('cancellation (E7)', () => {
    it('is scheduled for the period end, can be withdrawn, and ends as a billing state — never a suspension', () => {
      const active = authorized({
        currentPeriodStart: T0,
        currentPeriodEnd: day(30),
      });
      const scheduled = ok(
        transition(active, { type: 'CANCEL_SCHEDULED', at: day(3) }),
      );
      expect(scheduled.next).toMatchObject({
        status: 'ACTIVE',
        cancelAtPeriodEnd: true,
      });
      expect(
        ok(transition(scheduled.next, { type: 'CANCEL_SCHEDULED', at: day(4) }))
          .changed,
      ).toBe(false);
      expect(
        ok(transition(scheduled.next, { type: 'CANCEL_UNDONE', at: day(5) }))
          .next.cancelAtPeriodEnd,
      ).toBe(false);
      expect(transition(active, { type: 'CANCEL_UNDONE', at: day(5) })).toEqual(
        { ok: false, reason: 'NOTHING_TO_CANCEL' },
      );

      const ended = ok(
        transition(scheduled.next, {
          type: 'SUBSCRIPTION_ENDED',
          at: day(30),
          trialRecoveryDays: 3,
        }),
      );
      expect(ended.next).toMatchObject({
        status: 'CANCELED',
        canceledAt: day(30),
        cancelAtPeriodEnd: false,
      });
      expect(ended.suspension).toBe('NONE');
      expect(ended.history.map((h) => h.type)).toEqual(['CANCELED']);
      // Ended: nothing more applies to this subscription.
      expect(transition(ended.next, paid(day(31)))).toEqual({
        ok: false,
        reason: 'CANCELED',
      });
    });
  });

  describe('plan changes (E8)', () => {
    const active = authorized({
      currentPeriodStart: T0,
      currentPeriodEnd: day(30),
    });

    it('an upgrade is pending until ITS payment is confirmed, then the new plan applies', () => {
      const pending = ok(
        transition(active, {
          type: 'UPGRADE_REQUESTED',
          at: day(2),
          planVersionId: 'plan-v2',
          planPriceId: 'price-2',
          reference: 'inv-up',
        }),
      );
      expect(pending.next.planVersionId).toBe('plan-v1');
      expect(pending.history.map((h) => h.type)).toEqual([
        'PLAN_CHANGE_PENDING',
      ]);

      // Another payment (e.g. a renewal) does not activate the upgrade.
      const other = ok(transition(pending.next, paid(day(3), 'inv-other')));
      expect(other.next.planVersionId).toBe('plan-v1');
      expect(other.next.pending?.kind).toBe('UPGRADE');

      const applied = ok(
        transition(
          pending.next,
          paid(
            day(3),
            'inv-up',
            null as unknown as Date,
            null as unknown as Date,
          ),
        ),
      );
      expect(applied.next).toMatchObject({
        planVersionId: 'plan-v2',
        planPriceId: 'price-2',
        pending: null,
        status: 'ACTIVE',
      });
      expect(applied.history.map((h) => h.type)).toEqual([
        'PLAN_CHANGE_APPLIED',
      ]);
    });

    it('an upgrade whose payment fails is abandoned; the business keeps its plan and standing', () => {
      const pending = ok(
        transition(active, {
          type: 'UPGRADE_REQUESTED',
          at: day(2),
          planVersionId: 'plan-v2',
          planPriceId: 'price-2',
          reference: 'inv-up',
        }),
      );
      const r = ok(transition(pending.next, failed(day(3), 'inv-up')));
      expect(r.next).toMatchObject({
        status: 'ACTIVE',
        planVersionId: 'plan-v1',
        pending: null,
        pastDueAt: null,
      });
      expect(r.history.map((h) => h.type)).toEqual(['PLAN_CHANGE_ABANDONED']);
    });

    it('a downgrade applies at the period boundary, not before', () => {
      const scheduled = ok(
        transition(active, {
          type: 'DOWNGRADE_SCHEDULED',
          at: day(2),
          planVersionId: 'plan-v0',
          planPriceId: 'price-0',
          effectiveAt: day(30),
        }),
      );
      expect(scheduled.next.planVersionId).toBe('plan-v1');
      // A payment inside the current period leaves it pending.
      const early = ok(
        transition(scheduled.next, paid(day(10), 'inv-x', day(10), day(30))),
      );
      expect(early.next.planVersionId).toBe('plan-v1');
      // The renewal for the next period applies it.
      const renewal = ok(
        transition(scheduled.next, paid(day(30), 'inv-2', day(30), day(60))),
      );
      expect(renewal.next).toMatchObject({
        planVersionId: 'plan-v0',
        planPriceId: 'price-0',
        pending: null,
      });
      expect(renewal.history.map((h) => h.type)).toEqual([
        'PAYMENT_SUCCEEDED',
        'PLAN_CHANGE_APPLIED',
      ]);
    });

    it('refuses overlapping, no-op and invalid changes', () => {
      const pending = ok(
        transition(active, {
          type: 'UPGRADE_REQUESTED',
          at: day(2),
          planVersionId: 'plan-v2',
          planPriceId: null,
          reference: 'inv-up',
        }),
      ).next;
      expect(
        transition(pending, {
          type: 'DOWNGRADE_SCHEDULED',
          at: day(2),
          planVersionId: 'plan-v0',
          planPriceId: null,
          effectiveAt: day(30),
        }),
      ).toEqual({ ok: false, reason: 'CHANGE_PENDING' });
      expect(
        transition(active, {
          type: 'UPGRADE_REQUESTED',
          at: day(2),
          planVersionId: 'plan-v1',
          planPriceId: null,
          reference: 'r',
        }),
      ).toEqual({ ok: false, reason: 'SAME_PLAN' });
      expect(
        transition(active, {
          type: 'DOWNGRADE_SCHEDULED',
          at: day(2),
          planVersionId: 'plan-v0',
          planPriceId: null,
          effectiveAt: day(1),
        }),
      ).toEqual({ ok: false, reason: 'INVALID_EFFECTIVE_DATE' });
      expect(
        transition(
          authorized({
            status: 'PAST_DUE',
            pastDueAt: T0,
            graceEndsAt: day(14),
          }),
          {
            type: 'UPGRADE_REQUESTED',
            at: day(2),
            planVersionId: 'plan-v2',
            planPriceId: null,
            reference: 'r',
          },
        ),
      ).toEqual({ ok: false, reason: 'NOT_CHANGEABLE' });
    });
  });

  it('a zero-amount payment proves nothing: no trial ends, no recovery, no upgrade', () => {
    const trialing = billed({
      status: 'TRIALING',
      trialStartedAt: T0,
      trialEndsAt: day(14),
      trialRequiresPaymentMethod: false,
    });
    expect(
      ok(transition(trialing, paid(T0, 'inv-0', T0, day(14), 0))).changed,
    ).toBe(false);
    const unpaid = authorized({
      status: 'UNPAID',
      pastDueAt: T0,
      graceEndsAt: day(14),
    });
    const r = ok(
      transition(unpaid, paid(day(20), 'inv-0', day(20), day(50), 0)),
    );
    expect(r.changed).toBe(false);
    expect(r.suspension).toBe('NONE');
  });

  it('a late payment of an old invoice never moves the period backwards', () => {
    const active = authorized({
      currentPeriodStart: day(30),
      currentPeriodEnd: day(60),
    });
    const r = ok(transition(active, paid(day(61), 'inv-old', T0, day(30))));
    expect(r.next).toMatchObject({
      currentPeriodStart: day(30),
      currentPeriodEnd: day(60),
    });
  });

  it('a malformed period never overwrites a valid one', () => {
    const active = authorized({
      currentPeriodStart: T0,
      currentPeriodEnd: day(30),
    });
    const r = ok(transition(active, paid(day(30), 'inv-2', day(60), day(40))));
    expect(r.next).toMatchObject({
      currentPeriodStart: T0,
      currentPeriodEnd: day(30),
    });
  });

  it('a repeated authorization changes nothing', () => {
    expect(
      ok(transition(authorized(), { type: 'PAYMENT_AUTHORIZED', at: day(1) }))
        .changed,
    ).toBe(false);
    const r = ok(
      transition(billed(), { type: 'PAYMENT_AUTHORIZED', at: day(1) }),
    );
    expect(r.next.recurringPaymentAuthorizedAt).toEqual(day(1));
  });
});
