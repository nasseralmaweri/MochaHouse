# Restaurant card refunds: the foundation (ESP-04 M5a)

M5a lays the refund foundation for restaurant customer payments: the record, the rules, the
permission and the Stripe adapter. **Nothing in M5a moves money.** There is no endpoint, no
webhook handling and no UI; nothing calls the refund adapter.

| Slice | Adds |
|---|---|
| M5b | Refund execution, obligation settlement, staff API |
| M5c | Refund webhooks, recovery and Dashboard-refund detection |
| M5d | Staff and customer UI |

A refund always returns money on the **original** Stripe payment: a direct charge on the
restaurant's connected account. It is made on that same account, funded by the restaurant's
Stripe balance. CENTERIVO charges no application fee, so there is nothing to return to the
platform, and nothing to reverse because no transfer was made. Stripe does not return its
processing fees.

## The record: `PaymentRefund`

One row per refund **operation**:

* **`CENTERIVO`**: a refund CENTERIVO asks Stripe for.
  * It is saved as `REQUESTED` **before** Stripe is called.
  * It names the staff member, a reason code and an optional internal note. The note is never
    sent to Stripe, shown to the customer, or logged.
  * It carries its own server-generated idempotency key, `centerivo-refund:<refund id>`. Every
    retry of that operation reuses the key; a new operation always gets a new one.
* **`EXTERNAL`**: a refund made outside CENTERIVO, in the restaurant's Stripe Dashboard. It is
  recorded from what Stripe reports and always carries Stripe's refund id.

### Statuses

| Status | Meaning | Counts against the charge |
|---|---|---|
| `REQUESTED` | Saved; Stripe has not answered yet | yes |
| `PENDING` | Stripe accepted it; the money is on its way | yes |
| `UNKNOWN` | An answer was lost; it may have happened | yes |
| `SUCCEEDED` | Stripe refunded it | yes |
| `FAILED` / `CANCELED` | Stripe says it did not happen | no |
| `NOT_CREATED` | Proven never created at Stripe, with recorded evidence | no |
| `FAILED_AFTER_SUCCESS` | It succeeded, then Stripe returned the money | no (owed again) |

Moves are forward only:

```
REQUESTED -> PENDING | SUCCEEDED | FAILED | CANCELED | UNKNOWN | NOT_CREATED
UNKNOWN   -> PENDING | SUCCEEDED | FAILED | CANCELED | NOT_CREATED
PENDING   -> SUCCEEDED | FAILED | CANCELED
SUCCEEDED -> FAILED_AFTER_SUCCESS
```

A timeout or an API error never means "not refunded". It means `UNKNOWN`, which keeps its
amount reserved until a read-back from Stripe proves what happened.

### What the database guarantees (migration `20261124090000_payment_refunds`)

* **One business.**
  * Composite `(tenantId, id)` foreign keys tie each refund to its order, its payment, the
    staff who asked for or reviewed it, and its history. The tenant never changes.
  * A refund is always for **the order's own payment**.
* **Only a confirmed Stripe payment.** The payment must be:
  * a Stripe payment, `SUCCEEDED`, with an intent stored (`pi_…`);
  * on the account it was made on, in its currency;
  * not flagged for reconciliation (this applies to CENTERIVO refunds).
* **Which orders.** A CENTERIVO refund is only for an order that is:
  * `COMPLETED` (a refund of what was served); or
  * `REJECTED` or `CANCELLED` (its refund obligation).

  An order still in progress is cancelled instead, so a refund can never race a closure.
* **Capacity.**
  * The payment row is locked first, so concurrent requests are serialised.
  * A CENTERIVO refund is refused if REQUESTED, PENDING, UNKNOWN and SUCCEEDED refunds
    (including Dashboard ones) would then exceed what was charged.
  * A Dashboard refund is recorded as long as what Stripe accepted (PENDING and SUCCEEDED)
    stays within the charge. It is recorded even while a CENTERIVO request is unanswered:
    Stripe itself never lets refunds exceed the charge, so that request then cannot have
    happened.
* **Isolation.** Refunds are written only at `READ COMMITTED`, the default.
  * `REPEATABLE READ` and `SERIALIZABLE` are refused: they count from the transaction's
    snapshot, and a row lock alone raises no conflict against a `READ COMMITTED` writer.
  * Every refund status change, and every obligation settlement, takes the payment's lock, so
    a settlement can never race a late failure of its refunds.
* **"Never created" needs proof.** `NOT_CREATED` gives the amount back, so it is never inferred
  from a timeout, an error or time passing. It needs recorded evidence (`notCreatedEvidence`),
  which the database stamps with the time it was recorded, keeps unchanged, and writes into the
  history:
  * `NEVER_SENT`: the request was never sent to Stripe.
  * `STRIPE_HISTORY_VERIFIED`: the request was sent, and a **complete** read-back of the
    payment's refund history at Stripe, on its own account, shows no refund of this operation.
    This is allowed only after the 24-hour idempotency window. That condition is necessary
    but never sufficient: before then, the same key could still bring the refund back.

  M5b decides the evidence with `notCreatedEvidenceFor`. It returns nothing, so the refund
  stays `UNKNOWN` with its amount reserved, when:
  * Stripe cannot be read, or not every page was read;
  * the refund is found;
  * an unrecorded refund of the same amount without our id might be it.
* **Identity never changes:** business, order, payment, account, origin, amount, currency,
  reason, note, requester, idempotency key and creation time.
  * The Stripe refund id and the first-sent time are written once.
  * The Stripe refund id is unique everywhere.
  * A refund is never deleted.
* **Times come from the database clock, in UTC.** The creation, success, late-failure and
  review times are set by the database, never by the application, whatever the session's time
  zone.
* **A refund made outside CENTERIVO is recorded only as Stripe reports it:** `PENDING`,
  `SUCCEEDED`, `FAILED` or `CANCELED`. It is never inserted already returned or reviewed.
* **History is written by the database.**
  * Creation, every status change, the recording of Stripe's refund id and a late-failure
    review are written to `PaymentRefundEvent` by triggers.
  * The application **cannot insert those entries**, or any entry naming a status: a trigger
    refuses them unless they come from the history trigger itself.
  * The table is append-only: no update, delete or truncate.
  * The application may add attributed entries: `STAFF` for a business user, `PLATFORM` for a
    CENTERIVO operator id (never a foreign key, and never authority to refund), `SYSTEM` for
    neither.
  * Every function pins `search_path = public, pg_temp`, so a temporary table cannot shadow
    the real ones.
* **No card or personal data.** Only ids, amounts, codes and times are stored. Stripe metadata
  carries `centerivo_tenant_id` and `centerivo_refund_id` only.

## Refund obligations (R1 / S5b) and refunds

A rejected or cancelled order's `OrderRefundObligation` is always for its **whole card-paid
amount**. M5a adds guards only; every S5a / S5b guard is unchanged.

* **Every refund of the order's payment counts towards its obligation**, whenever and however
  it was made: before or after the closure, from CENTERIVO or from the Dashboard.
  * What is still owed is the obligation minus those refunds.
  * A new refund can only be for that remainder, never the whole obligation again. The
    capacity rule enforces this.
* **Settling an obligation** (`REFUNDED`, `PROCESSOR`) is allowed only when all of these hold:
  * the payment's succeeded refunds cover the whole obligation;
  * none is still in flight;
  * the recorded `processorRefundId` is one of those succeeded refunds;
  * no refund of the payment whose money came back is still unreviewed.

  These are verified from Stripe's read-back. There is no waiting period: a verified, complete
  refund settles at once. A partly refunded obligation is never marked satisfied.
* **A late failure** (`FAILED_AFTER_SUCCESS`): Stripe can still return a card refund after it
  succeeded, including after the obligation was recorded settled.
  * The refund's history is kept, immutable. Its amount is owed again: capacity returns, and
    `payment-refunds.ts` `obligationStanding` recalculates what is outstanding from the actual
    refunds.
  * **The case is flagged for staff attention.**
    * The history entry carries `obligationAlreadySettled` when the obligation had been
      settled.
    * `obligationStanding` reports `needsAttention` for an unreviewed return, or for a
      settled obligation its refunds no longer cover.
  * The database **blocks any replacement refund of that payment, and any settlement, until a
    staff member has recorded a review**, once, with a note. The review is audited in the
    history.
  * **The obligation is never presented as satisfied while money is owed.** A settled
    obligation cannot change (S5a: `REFUNDED` is terminal), so its `REFUNDED` is a record of
    the settlement, not a statement about today. What is owed always comes from the refunds,
    never from the obligation's status. M5b and M5c show and act on that calculated amount.
* **Manual settlement (S5c `MANUAL_EXTERNAL`) is refused for a Stripe payment.** Its refund
  goes back to the original card, through Stripe. A Dashboard refund is recorded as an
  `EXTERNAL` refund and counts like any other. Manual settlement remains available for
  payments that are not Stripe.
* **Closing an order** is refused while a refund of its payment is in flight (`REQUESTED`,
  `PENDING` or `UNKNOWN`): its outcome must be known first. This is enforced by the database
  and by the closure service, which returns a clear 409. Refunds already answered simply count
  towards the new obligation.

`apps/api/src/payment/payment-refunds.ts` holds the same rules as plain functions:
* which statuses reserve or are in flight;
* the allowed moves;
* how a Stripe read-back moves a refund (`transitionFor`; anything it cannot follow is an
  anomaly for people, never written);
* the refund summary and the obligation's standing.

## Permissions

`orders.refund` is a **business** permission, held at CORPORATE or LOCATION scope.

* The business's built-in administrator role (the business owner) holds it.
* A new built-in access level, **Refund Manager** (`orders.view` + `orders.refund`, assigned
  per location), is how the owner lets someone else refund.
* **Store Manager does not hold it.**
* Granting goes through the existing Administration → access levels, which requires
  `users.manage_roles` and is limited by the granter's own permissions.
* CENTERIVO platform operators are separate identities with their own platform permissions.
  They are not business staff and **never gain the authority to issue customer refunds**. In
  later slices, support may only look at refunds and recheck them with Stripe.

The migration grants `orders.refund` to every business's administrator role and creates the
Refund Manager access level for every business, assigned to nobody. New businesses get both
at provisioning.

## The Stripe adapter (`StripePaymentIntentProvider`)

These methods are test mode only, always on the stored connected account, and nothing calls
them in M5a.

* **`refundFactsFor`.** Reads the intent with its latest charge expanded: status, amount,
  amount received, currency, what Stripe has refunded of the charge, and whether it is
  disputed. Live or unreadable means null.
* **`createRefund`.** Calls `refunds.create`.
  * Parameters: `payment_intent`, `amount` (always explicit), `reason` and our two ids, sent
    with the operation's idempotency key.
  * Reasons: `requested_by_customer` or `duplicate`. `fraudulent` is not a staff decision in
    V1.
  * No `refund_application_fee`, no `reverse_transfer`.
  * A local refusal, made before anything is sent, is the only definitive "nothing was
    refunded". Every Stripe error, and any answer that is not this refund (another amount,
    intent or id), is `unknown`.
* **`retrieveRefund` / `listRefundsFor`.** Read a refund, or every refund of the intent
  (CENTERIVO's and the Dashboard's, bounded to 10 pages of 100), on the payment's own account
  and for that intent only.
* **Test mode.** The Refund object carries no `livemode`. Test mode is guaranteed by the
  test-mode key and by the intent, which `refundFactsFor` reads back as test mode first.
* **Idempotency.** Stripe keeps keys for at least 24 hours, and the same key with other
  parameters is refused. M5b will replay the same key within the replay window, then find the
  refund by listing the intent's refunds and matching our refund id and amount. It never
  creates a refund for the same operation with a fresh key.

## Required of M5b / M5c (not enforced by the database)

* **Read-backs only.** Write `EXTERNAL` refunds, and every status change, only from a Stripe
  read-back (`retrieveRefund` / `listRefundsFor`) on the payment's stored account. The
  database trusts what the application reports from Stripe.
* **Before asking Stripe**, refuse a disputed charge and compare `amountReceived` with the
  payment (`refundFactsFor`).
* **The account.** Pass the stored `PaymentRefund.providerAccountId` as the account.
* **Reviewing a late failure** requires `orders.refund` at the order's location, audited.
* **Deploy the API build before applying the migration.** An older API treats the new stored
  permission key as unknown and fails closed on those roles.

## Rollback

`prisma/rollbacks/20261124090000_payment_refunds.down.sql`, applied as a new forward
migration:

* It refuses while any refund or refund history exists.
* It refuses while anyone holds the Refund Manager access level.
* Otherwise it drops the tables, functions and triggers, the Refund Manager roles and the
  `orders.refund` grants.

The same trigger-bypass gate as the order closure applies (T-2 in
[order-closure.md](../operations/order-closure.md)): the runtime role must be neither a
superuser nor the owner of these tables.
