import {
  extendedDeadline,
  latestDeadline,
  needsPaymentSetup,
  paymentSetupCompleted,
  reminderDue,
  windowDeadline,
  type PaymentSetupRow,
} from './payment-setup';

// SC3e-4 — payment setup rules (pure).
const DAY = 24 * 60 * 60 * 1000;
const row = (over: Partial<PaymentSetupRow> = {}): PaymentSetupRow => ({
  billingMode: 'BILLED',
  status: 'ACTIVE',
  externalSubscriptionId: null,
  recurringPaymentAuthorizedAt: null,
  currentPeriodStart: null,
  ...over,
});
const paid = {
  externalSubscriptionId: 'sub_1',
  recurringPaymentAuthorizedAt: new Date(),
  currentPeriodStart: new Date(),
};

describe('SC3e-4 payment setup rules', () => {
  it('needs setup: billed and ACTIVE without a verified, paid subscription', () => {
    expect(needsPaymentSetup(row(), 'pro')).toBe(true);
    // An old provider subscription id alone is not setup.
    expect(
      needsPaymentSetup(row({ externalSubscriptionId: 'sub_old' }), 'pro'),
    ).toBe(true);
    expect(
      needsPaymentSetup(row({ ...paid, currentPeriodStart: null }), 'pro'),
    ).toBe(true);
    expect(needsPaymentSetup(row(paid), 'pro')).toBe(false);
  });

  it('excludes Founding, complimentary, trials, grace workflows and ended subscriptions', () => {
    expect(needsPaymentSetup(row(), 'founding')).toBe(false);
    expect(
      needsPaymentSetup(row({ billingMode: 'COMPLIMENTARY' }), 'pro'),
    ).toBe(false);
    for (const status of [
      'TRIALING',
      'PAST_DUE',
      'UNPAID',
      'TRIAL_EXPIRED',
      'CANCELED',
    ]) {
      expect(needsPaymentSetup(row({ status }), 'pro')).toBe(false);
    }
  });

  it('setup is complete only when verified: linked, authorized, and paid (or a carded trial)', () => {
    expect(paymentSetupCompleted(row(paid))).toBe(true);
    expect(
      paymentSetupCompleted(
        row({ ...paid, status: 'TRIALING', currentPeriodStart: null }),
      ),
    ).toBe(true);
    expect(
      paymentSetupCompleted(
        row({
          ...paid,
          recurringPaymentAuthorizedAt: null,
          status: 'TRIALING',
        }),
      ),
    ).toBe(false);
    expect(
      paymentSetupCompleted(row({ ...paid, currentPeriodStart: null })),
    ).toBe(false);
    expect(paymentSetupCompleted(row({ ...paid, status: 'PAST_DUE' }))).toBe(
      false,
    );
    expect(
      paymentSetupCompleted(row({ ...paid, externalSubscriptionId: null })),
    ).toBe(false);
  });

  it('a 14-day window, extended 1–14 days at a time, never past 30 days', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    expect(windowDeadline(start)).toEqual(new Date(start.getTime() + 14 * DAY));
    expect(latestDeadline(start)).toEqual(new Date(start.getTime() + 30 * DAY));
    const window = { startedAt: start, dueAt: windowDeadline(start) };
    const now = new Date(start.getTime() + DAY);
    expect(extendedDeadline(window, 14, now)).toEqual({
      ok: true,
      previous: window.dueAt,
      next: new Date(start.getTime() + 28 * DAY),
    });
    expect(extendedDeadline(window, 17, now)).toEqual({ ok: false });
    expect(
      extendedDeadline(
        { ...window, dueAt: new Date(start.getTime() + 28 * DAY) },
        3,
        now,
      ),
    ).toEqual({ ok: false });
    expect(extendedDeadline(window, 0, now)).toEqual({ ok: false });
    // A deadline already passed (not yet swept) extends from now.
    const late = new Date(start.getTime() + 15 * DAY);
    expect(extendedDeadline(window, 2, late)).toMatchObject({
      ok: true,
      previous: late,
    });
  });

  it('reminders 7, 3 and 1 days before', () => {
    const due = new Date('2026-01-15T00:00:00Z');
    const before = (days: number) => new Date(due.getTime() - days * DAY);
    expect(reminderDue(due, before(8))).toBeNull();
    expect(reminderDue(due, before(6.5))).toBe(7);
    expect(reminderDue(due, before(2.5))).toBe(3);
    expect(reminderDue(due, before(0.5))).toBe(1);
    expect(reminderDue(due, before(-1))).toBeNull();
  });
});
