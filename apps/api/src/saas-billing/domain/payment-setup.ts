// SC3e-4 — payment setup deadlines (owner decisions D1–D7), pure rules.
//
// A billed business NEEDS PAYMENT SETUP while it is ACTIVE without a verified,
// paid provider subscription: billing started but never set up, a
// complimentary arrangement ended with no subscription to return to, or a
// Checkout abandoned or expired. An old provider subscription id alone is
// never enough — setup is done only with a linked subscription, recurring
// payment authorized and a paid period. Excluded: Founding and complimentary
// businesses, trials (their own rules), PAST_DUE / UNPAID (grace), ended
// subscriptions.
//
// While billing enforcement is ON, such a business gets a 14-day window to
// set up payment (operators may extend it, never past 30 days from the
// window's start); when it passes, the business is suspended for billing
// (BILLING_WIND_DOWN). With enforcement off, only the informational "since"
// is recorded — no deadline, nothing changes.

export const PAYMENT_SETUP_WINDOW_DAYS = 14;
export const PAYMENT_SETUP_MAX_DAYS = 30;
// Reminders this many days before the deadline (largest first).
export const PAYMENT_SETUP_REMINDER_DAYS = [7, 3, 1] as const;
// An enforcement activation without a sweep for this long is over: the next
// sweep starts a NEW activation (fresh windows for everyone eligible).
export const ACTIVATION_GAP_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PaymentSetupRow {
  billingMode: 'BILLED' | 'COMPLIMENTARY';
  status: string;
  externalSubscriptionId: string | null;
  recurringPaymentAuthorizedAt: Date | null;
  currentPeriodStart: Date | null;
}

export function needsPaymentSetup(
  row: PaymentSetupRow,
  planKey: string,
): boolean {
  return (
    row.billingMode === 'BILLED' &&
    planKey !== 'founding' &&
    row.status === 'ACTIVE' &&
    !(
      row.externalSubscriptionId !== null &&
      row.recurringPaymentAuthorizedAt !== null &&
      row.currentPeriodStart !== null
    )
  );
}

// Payment setup verified as done: a linked provider subscription with
// recurring payment authorized, and either a paid period (ACTIVE) or a trial
// that has a payment method (TRIALING). Never only an opened or redirected
// Checkout, a client claim, or an unpaid / incomplete subscription.
export function paymentSetupCompleted(row: PaymentSetupRow): boolean {
  return (
    row.billingMode === 'BILLED' &&
    row.externalSubscriptionId !== null &&
    row.recurringPaymentAuthorizedAt !== null &&
    ((row.status === 'ACTIVE' && row.currentPeriodStart !== null) ||
      row.status === 'TRIALING')
  );
}

export function windowDeadline(start: Date): Date {
  return new Date(start.getTime() + PAYMENT_SETUP_WINDOW_DAYS * DAY_MS);
}

export function latestDeadline(start: Date): Date {
  return new Date(start.getTime() + PAYMENT_SETUP_MAX_DAYS * DAY_MS);
}

// The extended deadline: `days` (1–14) after the current deadline (or now,
// if that already passed), refused past 30 days from the window's start.
export function extendedDeadline(
  window: { startedAt: Date; dueAt: Date },
  days: number,
  now: Date,
): { ok: true; previous: Date; next: Date } | { ok: false } {
  if (!Number.isInteger(days) || days < 1 || days > 14) return { ok: false };
  const previous = window.dueAt > now ? window.dueAt : now;
  const next = new Date(previous.getTime() + days * DAY_MS);
  if (next > latestDeadline(window.startedAt)) return { ok: false };
  return { ok: true, previous, next };
}

// The reminder due now (7, 3 or 1 days before), or null.
export function reminderDue(dueAt: Date, now: Date): number | null {
  const remaining = dueAt.getTime() - now.getTime();
  if (remaining <= 0) return null;
  let due: number | null = null;
  for (const days of PAYMENT_SETUP_REMINDER_DAYS) {
    if (remaining <= days * DAY_MS) due = days;
  }
  return due;
}
