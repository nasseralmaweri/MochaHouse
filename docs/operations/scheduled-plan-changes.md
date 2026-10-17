# Scheduled plan changes (SC3d-3)

Stripe **test mode only**. Real Stripe test-mode validation of the schedule
flows (period end, trial end, release) is still a release requirement.
Billing enforcement and billing notifications stay disabled.

## What the business can do

A billing.manage user on **Admin → Billing** can:

- schedule a downgrade or annual → monthly for the end of the current period;
- choose the plan a trial becomes when it ends. This needs a payment method on
  file. A cardless trial is refused and keeps its normal expiry and recovery.

Nothing is charged when the change is scheduled.

A scheduled change can be cancelled until **one hour** before its date.
Cancelling **releases** the Stripe schedule; the subscription itself is never
cancelled.

Operators can prepare previews but cannot confirm or cancel.

## How it takes effect

CENTERIVO applies the new plan only when Stripe's **live** subscription shows
all of the following:

- the scheduled price;
- the same subscription and customer;
- a period that starts on (or after) the scheduled date.

The renewal payment is not required. A failed renewal follows the normal
PAST_DUE / grace policy at the new, lower price. Removed modules stop at the
switch. No tenant data is deleted.

Webhooks (`subscription_schedule.*`, `customer.subscription.updated`,
invoices) settle it. The plan-change sweep (every 5 minutes) is the backstop.

## Review case: `SCHEDULED_CHANGE_DISRUPTED`

This case is opened when one of these happens:

- the schedule was released, cancelled, removed or re-priced outside CENTERIVO
  before the date;
- the switch did not happen within 2 hours of the date;
- our records refused a schedule that Stripe created.

What CENTERIVO does:

- withdraws the pending change, so the business keeps its current plan;
- marks the change REVIEW;
- **never** recreates the schedule.

What to do:

1. Open the subscription in the Stripe test dashboard. Compare its price,
   period and any schedule with the plan change named in the case.
2. If a schedule is still attached and should not switch, **release** it.
   Do not cancel it: cancelling a schedule cancels the subscription.
   Note that a schedule left attached may still switch the price at its date.
   That would then raise `PRICE_MISMATCH`.
3. If the business still wants the change, ask them to schedule it again from
   their billing page. Do not recreate it in Stripe.
4. Mark the case reviewed with a note.

## Interrupted scheduling

- **Within 30 minutes:** a confirmation whose schedule creation was
  interrupted is re-sent with the same idempotency key. The date is re-checked
  first.
- **After 30 minutes:** it is never re-sent.
  - No schedule at Stripe: the change is closed (`NOT_SUBMITTED`).
  - Our matching schedule: it is adopted.
  - Anything else: `PLAN_CHANGE_UNCERTAIN`.
