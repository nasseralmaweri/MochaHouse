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

## Stripe outcome recovery (ESP-04 M4a)

When Stripe payments are configured (`PAYMENT_PROVIDER=stripe`), each sweep
runs two extra phases **before** fulfilment, so a payment found paid gets its
order in the same sweep. Both are part of the same sweeper, so the same
`PAYMENT_AUTO_RECOVERY_ENABLED=1` switch turns them on (off by default). No
migration.

### Phase 1: held Stripe payments

- **Which payments.** CHARGING, UNKNOWN or AWAITING_CONFIRMATION.
  - CHARGING is untouched for 10 minutes, because its first request may
    still be talking to Stripe. The others wait the usual 2 minutes.
  - At most 10 per sweep, oldest first.
  - Each runs under the **same per-payment lock** as fulfilment, so the two
    never run together on one payment.
- **Intent known.** It is read back on the payment's stored account, which
  must still be the business's own. The move is a conditional update from
  the exact state and intent that were read:

  | Stripe says                                      | The payment                                                      |
  | ------------------------------------------------ | ---------------------------------------------------------------- |
  | succeeded, for the frozen amount and currency    | SUCCEEDED, then the order exactly once                           |
  | succeeded, another amount or currency            | held; `STRIPE_AMOUNT_MISMATCH`, set aside for people             |
  | processing                                       | AWAITING_CONFIRMATION (held), rechecked later                    |
  | waiting for a card, nothing received             | REQUIRES_CUSTOMER_ACTION (live on the same intent)               |
  | cancelled, nothing received                      | FAILED: the holds are released, the case resolves `NOT_CHARGED` |
  | unreadable, live mode, or anything else          | unchanged (`STRIPE_UNREADABLE`, retried)                         |

- **No intent recorded.** The original creation is replayed:
  - the same idempotency key, account and byte-identical parameters;
  - **only within 20 hours** of the payment's creation.

  Outcomes:
  - **The answer names an intent:** the intent is recorded (only into an
    empty reference, one Stripe payment per intent), then read back as
    above.
  - **A cached 500, a timeout, a concurrent-key conflict, or a local refusal
    (e.g. the business left the allowlist):** unchanged, retried. None of
    them proves anything about the original request.
  - **Past the window (`STRIPE_CREATE_EXPIRED`), a key refused with these
    parameters, or an intent that already belongs to another payment
    (`STRIPE_IDEMPOTENCY_CONFLICT`):** never replayed again. Set aside for
    people with the holds kept.
- **Amount checked at every step.**
  - An intent that Stripe reports is **for** another amount or currency is
    never linked by a replay and never made live again or held as processing.
  - The payment is held instead, as `STRIPE_IDEMPOTENCY_CONFLICT` or
    `STRIPE_AMOUNT_MISMATCH`, and set aside for people.
- **Paid but no order yet.** If Stripe confirms the payment but its order
  can't be created right away, the result is `STRIPE_FULFILMENT_PENDING`.
  - It is **not** reported as settled: an unmatched event stays open with a
    case.
  - Fulfilment recovery creates the order exactly once.
- **Webhooks for held payments.** A Stripe webhook for a held payment whose
  intent is known goes through the same read-back. It is acknowledged only
  once Stripe's answer is recorded, never on the payment's stored state.
- **History.** `STRIPE_RECHECK_STARTED`, `_SUCCEEDED` (with the outcome) or
  `_FAILED` (with a fixed failure code and whether it is retryable). These
  are **counted separately** from fulfilment attempts: the same 5-attempt cap
  and backoff of 5 min × 2ⁿ up to 6 h. Once set aside, the case shows **Needs
  attention**.

### Phase 2: unmatched Stripe events

- **Which events.** An `UNMATCHED` payment event from the last 7 days whose
  connected account is one of our businesses' accounts, and whose intent that
  business's Stripe payment now names on that same account. Metadata is
  never used.
- **What happens.** The payment is reconciled at once through the idempotent
  paths:
  - a held payment goes through phase 1's recovery;
  - any other payment goes through the webhook's own read-back.

  The event becomes `PROCESSED` (`LINKED_BY_RECOVERY`). This works with
  `RESTAURANT_PAYMENT_EVENT_REDRIVE_ENABLED` off and needs no redelivery.
- **Limits.** At most 20 per sweep from a scan of 100. The least recently
  tried go first (never-tried before anything), with a per-event backoff of
  1 to 60 minutes and a cap of 8 tries. An event still failing never crowds
  out the ones behind it.
- **Not settled yet.** The event stays `UNMATCHED` and the payment gets a
  `PROVIDER_EVENT_NOT_SETTLED` case.

### Platform Console

- **Recheck with Stripe** (`POST /api/v1/platform/payment-cases/:caseId/recheck`).
  Runs one phase 1 recovery now. It is also allowed for a payment waiting for
  its customer: it reads that payment back through the customer's own check
  path.
  - **Access:** `payments.reconciliation.manage`, a recent sign-in, and a
    reason, which is kept as a note.
  - **Audit:** `platform.payment_case.stripe_recheck_requested`. SUCCEEDED
    carries the result, or `RECHECK_FAILED_<failure>`. DENIED carries the
    refusal code: a resolved case, a payment that isn't Stripe or isn't
    pending, or a recovery already running.
  - **Counting:** it does not count toward the automatic attempts.
- **Unmatched Stripe events** (`GET /api/v1/platform/payment-events/unmatched`,
  page `/platform/payments/unmatched`).
  - **Access:** `payments.reconciliation.view`, read-only.
  - **Shown:** the newest 100, with type, time received, tries, account,
    intent and the business the account belongs to. No event body or
    personal data.
- **Case details.** A case's detail shows its Stripe recheck history and the
  next automatic recheck.

## Abandoned Stripe payment cleanup (ESP-04 M4b)

A Stripe payment waiting for its customer keeps its holds (a coupon
redemption, a gift-card amount, Mocha Beans) until it is paid or cancelled.
A **third** Stripe phase of the same sweeper cancels the ones whose customer
has long gone, but only when Stripe proves them unpaid.

### Switches

- `PAYMENT_ABANDONED_INTENT_CANCEL_ENABLED=1` turns it on. It is **off by
  default**, and runs only inside the automatic sweeper, which also needs
  `PAYMENT_AUTO_RECOVERY_ENABLED=1`.
- `PAYMENT_ABANDON_AFTER_MINUTES` sets the deadline: 30 to 1440, default
  **120**. Any other value stops the API from starting.

### What counts as abandoned

All of these must hold:
- a Stripe payment, PENDING and REQUIRES_CUSTOMER_ACTION;
- its intent and connected account are stored;
- it was created before the deadline;
- its last **verified activity** (`customerActiveAt`, the checkout page's
  heartbeat) is also before the deadline.

Inactivity counts from the later of creation and the last heartbeat. Sending
the client secret to a browser is never counted as activity.

The scan takes at most 10 per sweep, oldest first. It skips cases set aside
for people, and applies a backoff of 5 min × 2ⁿ with a cap of 5 attempts.
History is kept as `STRIPE_ABANDON_STARTED`, `_SUCCEEDED` or `_FAILED` on the
payment's case, which is opened as `STRIPE_ABANDONED_CHECKOUT`.

### One cancellation

Each runs under the **same per-payment lock** as every other recovery.

1. **Database.** The payment is re-read: still waiting, still inactive.
2. **Stripe.** The intent is read on the stored account, with its latest
   charge.
   - **Authentication in progress** (`requires_action`,
     `requires_confirmation`): **never cancelled**. Held, with a
     `STRIPE_AUTHENTICATION_STALE` event, and set aside for people (Needs
     attention).
   - **Paid, processing, already cancelled, or anything else:** never
     cancelled here. It is settled from Stripe through the customer's own
     check path, so a paid payment gets its order exactly once.
   - **`requires_payment_method`, but not provably unpaid:** another amount
     or currency, money received, a next action pending, or a latest charge
     that isn't absent or failed. Held as `STRIPE_ABANDON_UNSAFE`, set aside
     for people.
3. **Final check.** Still waiting and still inactive. A heartbeat since step
   1 means `STILL_ACTIVE`, and nothing is cancelled.
4. **Cancel.** Reason `abandoned`, key `<payment key>:abandon`, on the
   stored account. Its answer is only a hint.
5. **Always read back.** Through the conditional transition:

   | Stripe now says                          | Result                                                                                  |
   | ---------------------------------------- | --------------------------------------------------------------------------------------- |
   | Cancelled, nothing received              | FAILED; the database releases the holds; the case resolves `NOT_CHARGED`                |
   | Paid (the customer paid during the race) | The order, exactly once                                                                 |
   | Processing                               | Held                                                                                    |
   | Still waiting, or unreadable             | Unchanged, holds kept, retried (`STRIPE_CANCEL_UNCONFIRMED` / `STRIPE_UNREADABLE`)      |

Holds are never released because time passed, on a cancel answer, on an API
error, or on anything a browser says.

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
