# Payment setup deadlines (SC3e-4)

This covers Stripe **test mode only**. `BILLING_ENFORCEMENT_ENABLED` and
`BILLING_NOTIFICATIONS_ENABLED` stay **off**. With enforcement off, nothing
in this runbook changes anyone's access.

## Who it applies to (D1)

A billed business **needs payment setup** while all of these hold:
- it is billed (not complimentary);
- it is ACTIVE;
- it has no verified, paid Stripe subscription. Verified means a linked
  subscription, recurring payment authorized, and a paid period. An old
  subscription id alone never counts.

A business gets here in three ways:
- an operator started billing and the owner hasn't set up payment;
- a complimentary arrangement ended and there was no subscription to return
  to;
- a Checkout was abandoned or expired.

These are **never** covered:
- Founding and complimentary businesses;
- trials, which keep their own trial and recovery rules;
- past-due and unpaid businesses, which keep their grace workflows;
- canceled businesses.

## The deadline (D2, D4)

| Enforcement | What happens |
|---|---|
| **Off** | Only *since when* is recorded (history: `PAYMENT_SETUP_REQUIRED`). No deadline is shown or applied. |
| **On** | The enforcement sweep gives each such business a **14-day window**: it records the window's start and deadline (history: `PAYMENT_SETUP_WINDOW_STARTED`). |

**One window per episode.** An episode starts when a business begins
needing payment setup. It ends only when setup is verified, the subscription
ends, or the business becomes complimentary.
- **First activation.** Businesses that were already waiting when
  enforcement is first switched on get their first, fresh 14-day window then.
- **Persisted deadlines.** A deadline is stored and is never reset or
  extended by any of these:
  - worker outages or restarts;
  - sweep gaps, or enforcement being paused and resumed;
  - Checkout retries;
  - payment failures or other state changes, such as going past due and
    back.
- **Deadlines passed during an outage or pause.** A deadline that passed
  while sweeps were down applies at the next sweep with enforcement on.
  While enforcement is off, no deadline is shown and nobody is paused.
- **Activation records.** Each period in which enforcement runs is recorded
  as a `BillingEnforcementActivation`. A sweep after a gap of more than 24
  hours records a new one and logs a warning. It never resets a window.
- **New episodes.** Only a genuinely new episode, after setup was completed
  or the subscription ended, gets a new 14-day window.

**Extensions.** An operator with `billing.accounts.manage` can extend a
deadline from the business's page in the console (**Payment setup → Extend
deadline**):
- a sign-in within the last 15 minutes and a reason are required;
- 1–14 days at a time;
- **never past 30 days from the window's start** (the database refuses it
  too);
- each extension is recorded with its reason and operator, adds a history
  entry and is audited (`platform.billing.payment_setup_extended`).

Opening Checkout again — or an abandoned or expired Checkout — never resets
or extends the deadline.

## When the deadline passes (D3)

The sweep marks the window expired (`PAYMENT_SETUP_EXPIRED`) and applies the
existing **billing suspension** (`BILLING_SUSPENDED`), the same
`BILLING_WIND_DOWN` restrictions as an unpaid subscription:

- **Paused:** the public storefront, so no new sales, and all general
  administration (premium features included).
- **Still available:** billing (Set up payment, invoices) and completing
  orders accepted before the suspension, through the existing wind-down
  routes. The paused refund and order-cancellation workflows are unchanged.
- **Never touched:** a SECURITY or administrative suspension. All business
  data is kept.
- **Notice:** the business gets a `PAYMENT_SETUP_EXPIRED` notice (queued only
  with notifications enabled).

## Recovery (D5)

The owner can open Checkout while paused. After an expired window, Checkout
offers **no trial**: payment comes first.

Access is restored, and `BILLING_SUSPENSION_LIFTED` and
`PAYMENT_SETUP_COMPLETED` are recorded, only when **all** of these hold:
- Stripe confirms setup: a linked subscription, payment authorized, and a
  paid period (or a trial with a payment method);
- no invoice of the subscription is still owed;
- billing enforcement is on (it is what paused the business).

Each of the following leaves the business paused:
- opening Checkout;
- returning from Checkout;
- a client claim;
- an unpaid or failed first invoice (the subscription becomes past due; its
  grace rules apply, and the setup record stays until payment is
  confirmed).

Duplicate and delayed Stripe events are idempotent. The sweep retries a
recovery that was waiting for an invoice to be recorded paid.

## Visibility and reminders (D6)

- **Business billing page:** shows that payment setup is needed, the deadline
  (only when enforced), the **Set up payment** button, and recovery guidance
  after the deadline.
- **Platform Console:** **Billing → Awaiting payment setup** lists each
  business with its deadline and extensions. The business page shows the
  window, the latest allowed deadline, the extension history and the extend
  form.
- **Reminders:** sent **7, 3 and 1 days** before the deadline
  (`PAYMENT_SETUP_ENDING`). They are deduplicated per deadline and day, and
  queued only when **both** enforcement and notifications are on. No email
  is sent in development.

## Operating notes

- **Sweep outages never reset deadlines.** If no enforcement sweep runs for
  24 hours, for example because the worker was down, the API logs a warning
  when sweeps resume. Every persisted deadline and extension still applies,
  and a deadline that passed during the outage applies at the next sweep.
  Before resuming enforcement after a deliberate pause, check the Awaiting
  payment setup list for deadlines that have already passed.
- **Turning enforcement off lifts nothing.** It doesn't lift a billing
  suspension that already happened, consistent with the other billing
  suspensions. The deadline is hidden, the business still sees it is paused,
  and recovery through payment works again once enforcement is on. To
  restore access with enforcement off, an operator reactivates the business.
- **Fluctuations keep the same episode.** If a payment fails (past due,
  unpaid) or a trial starts and the business later needs setup again, it
  keeps its original deadline and extensions. Opening or abandoning
  Checkout never resets the deadline either. Only a completed setup or an
  ended subscription closes the episode; a later need starts a new one.

## Rollback

`prisma/rollbacks/20261105090000_payment_setup_deadlines.down.sql` refuses
while any of the following exists:
- payment setup state;
- an activation;
- a payment setup extension;
- a payment setup history entry;
- a payment setup notice.

Otherwise it restores the SC3e-3 shape exactly.
