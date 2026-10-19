# Pre-charge financial holds (ESP-03 PR 8)

A restaurant payment no longer starts unless everything its order will spend
is still available and has been reserved for it. Two checkouts can never
both be charged for the last coupon redemption, the same gift-card balance
or the same Mocha Beans. This covers food-order checkout. CENTERIVO's own
SaaS billing is unchanged, and no real payment processor is connected.

## What is held

| Hold                   | Amount                             | Source                                                                |
| ---------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `PROMOTION_REDEMPTION` | 1 redemption                       | The order's promotion or coupon, with the customer (null for a guest) |
| `GIFT_CARD_TENDER`     | The gift-card amount (minor units) | The gift card                                                         |
| `LOYALTY_REDEMPTION`   | The reward's Mocha Beans           | The customer's loyalty account                                        |

**Available** means the balance or limit minus every **ACTIVE** hold.

- Promotions: used redemptions plus held redemptions must stay within the
  total limit, and per customer within the per-customer limit.
- Gift cards and Beans: the balance minus held amounts must cover the amount.

Hold rows store only ids, kinds, amounts and timestamps. They hold no contact
details, codes or payment credentials.

## Reserving

Holds are created in the **same transaction** that creates the payment
attempt and its frozen checkout (PR 7), before the provider is called.

- Each source row is locked (`FOR UPDATE`) and its availability re-checked.
- Locks are always taken in the same order: promotion, gift card, loyalty
  account. The order transaction applies redemptions in the same order, so
  reserving and fulfilling cannot deadlock.
- If anything is no longer available, the whole transaction rolls back: no
  attempt, no saved checkout, no hold. Nothing is charged. The customer gets
  `409 CHECKOUT_RESOURCE_UNAVAILABLE`, and the checkout page re-reads the
  quote so they can review the corrected total.
- The early checks (the coupon pre-check, the reward's "can afford", and the
  gift-card amount) use the available amount too. They only make the
  refusal earlier; the reservation is authoritative.

## Consuming, releasing and keeping

| Payment                                                                                  | Holds                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Succeeded, order created (including retries, automatic and support recovery)             | **Consumed** exactly once, in the order transaction                                              |
| Zero card charge (a gift card or reward covers everything)                               | Reserved with the attempt, consumed in the order transaction; the provider is never called       |
| Declined or failed                                                                       | **Released** by the database in the same statement that records the outcome, whatever records it |
| Saved but never sent, abandoned (when the checkout is resumed, or by the recovery sweep) | **Released** by the database in the same statement that closes it                                |
| Charging, awaiting confirmation, unknown                                                 | **Kept**                                                                                         |
| Succeeded but the order could not be created (kept for review)                           | **Kept** until the order is created                                                              |

Holds are never released because time passed or a browser session expired.
Only a payment that was **never sent** (still NOT_SENT ten minutes after it
was saved) is closed by time: the charge claim needs that same state, so it
cannot have been, or ever be, charged. If recording a decline fails, nothing
is released and the payment is treated as held, as in PR 3.

Before applying its redemptions, the order transaction checks that this
payment's holds are ACTIVE and match exactly what it applies. A payment from
before this PR has no holds, so it reserves them at that point, against what
other payments hold. Any mismatch or shortfall keeps the payment for review:
it is never re-priced and never charged again.

## The database enforces it

- One hold per kind per payment attempt.
- Exactly the source each kind needs, and a positive amount.
- A hold, its payment and its source belong to one business (composite
  foreign keys).
- A guard trigger:
  - a hold is created only ACTIVE, for a payment that is pending or has
    succeeded;
  - it changes only ACTIVE → CONSUMED (payment succeeded) or ACTIVE →
    RELEASED (payment declined or failed);
  - its source and amount never change;
  - it is never deleted.
- A trigger on `PaymentAttempt` releases a payment's ACTIVE holds in the same
  statement that records it as DECLINED or FAILED (reason DECLINED, FAILED or
  ABANDONED), so no present or future code path can leave them reserved.

## Everything else respects holds

- **Staff Mocha Bean adjustments and gift-card corrections** cannot deduct
  held amounts. Credits are unaffected.
- **Promotion limit edits** cannot set the total limit below used plus held,
  or the per-customer limit below the most any one customer has used plus
  held.
- **Checkout previews and the public gift-card balance check** show what is
  available now. Whoever holds a card code therefore sees a lower balance
  while an order paying with that card is in progress. That is the balance
  they can actually spend, and it reveals no order or customer details.

## Coupon policy

- A coupon (or automatic promotion) with a per-customer limit needs a
  signed-in customer. A guest is told to sign in and is never identified by
  email or phone instead. This is checked when the coupon is resolved and
  again when it is reserved.
- Guests may use coupons that only have a total limit.

## Migration

`20261119090000_financial_holds` only adds things:

- one table with its indexes and constraints;
- the guard trigger and its function.

It runs as one DO block (atomic), with a read-only preflight and a 5s lock
timeout. The rollback refuses while any hold exists, because active holds
reserve money for payments in progress and settled ones are their history.
Tested on disposable databases only.

## Remaining requirements before live restaurant payments

- **Resolving held payments.** Holds of a payment that stays pending or
  unknown are kept until the provider's answer is recorded. Provider webhooks
  or status lookups (with the payment processor integration) are needed so
  these resolve, and their holds are released or consumed.
- **Refunds for paid but unfulfillable orders.** Their holds stay until the
  order is created. The approved void or refund path will release them.
- **Order cancellation and closure (OFF).** Before they are enabled, their
  reversals must respect holds: restoring and removing Beans, gift-card
  balance and promotion counts.
- **Gift-card deactivation** is still allowed while a card has held amounts,
  for example to stop fraud. A paid order needing that card is then kept for
  review.
- **Holding capacity.** Each checkout session holds at most one live payment,
  and `POST /orders` (the only step that creates holds) is rate limited per
  customer, per IP and per business. Never-sent payments are closed by the
  recovery sweep, which stays OFF until automatic recovery is switched on.
  With a real provider, pending and unknown payments keep their holds until
  they resolve (see the first item), so per-promotion caps on live holds may
  be worth adding before limited offers are run with real payments.
- **Payments from before this PR** reserve what they need when their order is
  created. If another payment holds it by then, they are kept for review
  rather than fulfilled past a limit or balance.
