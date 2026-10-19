# Payment reconciliation and automatic recovery (ESP-03 PR 5)

A restaurant payment that the provider confirmed, but whose order or gift card
was never created, is completed from what was saved before the charge. Support
can see every payment that needs reconciliation and ask for a safe recovery.
Nothing here charges a customer. This covers restaurant customer payments
only (food-order checkout and gift-card purchases). CENTERIVO's own SaaS
billing is separate and unchanged. No real payment processor is connected.

## What can be recovered

A payment is recovered only when all of these hold:
- the provider's outcome is definitive success (`status = SUCCEEDED` and
  `paymentState = SUCCEEDED`);
- it has no order and no issued gift card;
- something durable was saved before the charge: the saved checkout
  (`CheckoutSnapshot`, ESP-03 PR 4), or the gift-card purchase row.

A payment that is pending, charging, awaiting confirmation, unknown, declined
or from before ESP-03 is never recovered. No outcome is ever invented: an
uncertain payment's case stays open as **Awaiting verified payment outcome**
until a verified provider outcome exists (there is no provider verifier yet).

## How a recovery runs

- **No charge.** Recovery uses only the PR 4 fulfilment paths
  (`CheckoutService.recoverFulfilment`, `GiftCardPurchaseService.recoverIssuance`).
  Neither can reach the payment provider.
- **Exactly once.** Both paths lock the payment attempt row, require a
  confirmed payment, and return a record that already exists. A recovery that
  races a customer retry, another recovery or another server still produces
  one order or one card.
- **One recovery per payment at a time.** A session-level PostgreSQL
  advisory lock is held on a dedicated connection for the whole attempt,
  across processes. It is released when the attempt ends, or by PostgreSQL
  if the process stops. No database transaction is held open across the
  work, so no timeout can separate the work from its lock. A second caller
  is told the payment is busy and writes nothing.
- **Frozen checkout (ESP-03 PR 7).** The order transaction creates the
  order from the frozen checkout after verifying its arithmetic against the
  payment; it never re-prices. If the order cannot be created (a promotion
  limit reached, Beans or a gift card no longer covering the frozen amount,
  a suspended business or a location no longer taking orders, or a frozen
  checkout that does not match the payment), the recovery fails as
  `FULFILMENT_REJECTED`, the case stays open, and the sweeper does not retry
  it. Support can retry after fixing the cause. Version-1 saved checkouts
  are still re-priced, and a price change rejects them the same way.
- **Gift cards.** The card is issued from the purchase row. The code never
  leaves recovery: the buyer retrieves it through their own authorised replay
  within the existing seven-day window.

## The automatic sweeper

- It runs inside the API process (owner decision R1, option A), and is
  **OFF unless `PAYMENT_AUTO_RECOVERY_ENABLED=1`**. No deployment enables it
  in this slice.
- Every 60 seconds it takes at most 10 due payments, oldest first. A payment
  is due two minutes after its last update, so the first request has time to
  finish on its own.
- Only one sweep runs at a time: an in-process flag, plus an advisory lock
  across processes.
- ESP-03 PR 8: each sweep first closes, as ABANDONED, at most 50 food-order
  payments saved but never sent to the provider more than ten minutes ago.
  This uses the same conditional update from NOT_SENT that the charge claim
  needs, so nothing can have been charged. The database releases their
  financial holds in that same statement.
- Payments set aside for people (attempts used up, or a failure a retry
  cannot fix) are excluded in the database query itself, and the scan pages
  through candidates. They can never fill the scan and stop recovery for
  everyone else.
- **Backoff:** every automatic attempt counts from the moment it starts,
  including one that was interrupted. After n attempts it waits
  5 min × 2^(n−1) from the latest attempt, capped at 6 hours. After 5
  attempts it stops, and the case shows **Needs attention**. A failure that a retry cannot fix (an exhausted
  promotion limit, a suspended business, an unreadable saved checkout) is not retried automatically.
- A recovery that started but recorded no outcome for 5 minutes (the process
  stopped) is no longer shown as in progress. It counts as one attempt.

## History and resolution

- Every payment being recovered has a reconciliation case. If a crash left a
  confirmed payment without one, recovery opens it first
  (`FULFILMENT_INCOMPLETE`). There is at most one case per payment
  (a unique key).
- Each attempt is history on the case. These are append-only SYSTEM events:
  - `RECOVERY_STARTED`;
  - then `RECOVERY_SUCCEEDED` or `RECOVERY_FAILED`, with the trigger
    (`automatic` or `platform_support`);
  - with a fixed failure code and record ids only. No personal data or
    provider text.
- A case is resolved only when the durable record exists. The order or
  gift-card transaction resolves it. A recovery that finds the record already
  there resolves it under the payment row lock.
- The `RESOLVED` event records:
  - the state before and after;
  - the payment;
  - the order or gift-card purchase that proves it.
- Nothing in this slice resolves a case manually, invents a payment or
  records a refund.

## Platform Console support

Routes are under `/api/v1/platform/payment-cases`. Pages are under
`/platform/payments`.

- **Who:** active platform operators only. Reading needs
  `payments.reconciliation.view`. A recovery request or a note needs
  `payments.reconciliation.manage` and a recent sign-in. Permissions are
  granted only through the existing audited grant flows. Business staff and
  customers cannot reach these routes.
- **What support sees:**
  - the business;
  - amount, payment states and the provider reference;
  - the order number or gift-card purchase id;
  - fixed reason and failure codes;
  - the recovery history and next automatic attempt;
  - internal notes.
- **What support never sees:**
  - card data and gift-card codes;
  - the saved checkout;
  - guest or customer contact details;
  - provider error text;
  - the restaurant staff member behind a staff action.
- **Filters:** business, status, category (Needs attention, Recovery in
  progress, Recovered, Awaiting verified payment outcome, Closed) and date.
- **Recover now:** the same path as the sweeper. It is refused (409) for a
  resolved case, a payment that is not confirmed, one with nothing saved, or
  one being recovered. A refusal writes nothing to the case, and is audited
  as `platform.payment_case.recovery_requested` with outcome DENIED and the
  refusal code. An attempt that ran is audited with outcome SUCCEEDED and
  reason code `RECOVERED`, `ALREADY_FULFILLED` or
  `RECOVERY_FAILED_<failure>`. The written reason is kept as a note.
- **Notes:** `PaymentReconciliationNote`, tenant-owned, with a composite
  foreign key to its case.
  - They hold 1–1000 characters, with at least one that is not whitespace.
  - They are append-only: a database trigger refuses UPDATE and DELETE.
  - The author is a platform operator id, never a foreign key from business
    data to platform data.
  - Each note is audited as `platform.payment_case.note_added`.

## Customer retries (PAY-4)

A retry with the same idempotency key never starts another charge. Depending
on the payment's state:
- **pending:** the retry is refused;
- **charging, awaiting confirmation or unknown:** the customer is told the
  payment is being confirmed and not to pay again;
- **succeeded:** the existing order is returned, or created once from the
  saved checkout;
- **under recovery:** the retry meets the same single order.

Reliable duplicate prevention across different keys is deferred to ESP-03
PR 6 (owner decision R3).

## Migration

`20261116090000_payment_reconciliation_support` is additive:
- the notes table, with its checks and its tenant-ownership and append-only
  triggers;
- the operator permission CHECK, replaced with a superset that adds the two
  permissions.

A preflight refuses to run, changing nothing, if the ownership guard function
is missing or the table already exists. The rollback
(`prisma/rollbacks/20261116090000_payment_reconciliation_support.down.sql`)
refuses while any note or `payments.reconciliation.*` grant exists.
