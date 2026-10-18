# Resumable order fulfilment (ESP-03 PR 4, PAY-3)

A charged restaurant order is always recoverable, and recovery never charges
again. This covers restaurant customer payments only: food-order checkout and
gift-card purchases. CENTERIVO's own SaaS billing is separate and unchanged.
No real payment processor is connected.

## The saved checkout

- **What it is:** `CheckoutSnapshot`, one row per food-order payment attempt,
  tenant-owned. Migration `20261115090000_checkout_snapshots` is additive,
  with a preflight and a guarded rollback.
- **When it is written:** after the server has validated and priced the
  checkout, and before anything is charged. It is written in the same
  database transaction as the payment attempt, and both are committed before
  the payment provider is called. If the snapshot cannot be saved, no payment
  attempt exists and nothing is charged.
- **What it holds** (payload version 1), and nothing else:
  - the location;
  - the cart lines and their choices, as ids only;
  - the guest contact as it will appear on the order;
  - the customer id, the reward id and the normalised coupon code;
  - the gift-card tender plan: the card's id, last four digits and planned
    amount. Never the card's code, which is a bearer secret;
  - the plan features decided at checkout.
- **What it never holds:** card data, credentials, idempotency keys or
  provider secrets.
- **Bounds:** the database limits the payload to a JSON object of at most
  64 KB, version 1.

## Creating the order

There is one path, for the first attempt and every recovery alike:
1. It reads the saved checkout, never the request, and never a retried or
   changed cart.
2. Inside one transaction it locks the payment attempt row.
3. It requires the payment to be definitively charged
   (`status = SUCCEEDED` and `paymentState = SUCCEEDED`). A held or unknown
   payment is never treated as a success.
4. If the order already exists, it returns it as it is.
5. Otherwise it creates the order and its gift-card, loyalty and promotion
   effects, exactly as before.
6. In the same transaction it deletes the saved checkout, marks the payment
   `fulfilmentStatus = DONE`, clears its review flag, and resolves any open
   reconciliation case as `FULFILLED` with a SYSTEM event.

Effects happen exactly once. The payment row lock serialises every path, the
database allows one order per payment, and every effect commits in the order's
own transaction. So retries and concurrent recoveries can't create a second
order or spend a gift card, reward or coupon twice. The payment provider is
never called.

**Pricing:** until frozen pricing arrives (ESP-03 PR 7), the order is
re-priced from the live menu with the existing check against the amount
charged. If they disagree, nothing is created or changed: the payment stays
`SUCCEEDED`, flagged for review with an open case, and keeps its saved
checkout. Once the price matches again, recovery completes.

## When creating the order fails

The payment stays `SUCCEEDED` and is never marked failed:
- it is flagged `reconciliationRequired` with `fulfilmentStatus = NEEDS_REVIEW`;
- it gets an open `FULFILMENT_FAILED` reconciliation case;
- its saved checkout is kept.

If even that cannot be written (the database is unavailable), the payment id is
logged. The saved checkout still makes the order recoverable.

**A lost commit acknowledgement** (the order, or a gift card, was committed but
the request saw an error): the existing order or card is the answer. Nothing is
flagged, and no case is opened. A purchase that has its card is always treated
as issued, whatever its status says.

## Recovery

- **Customer retry:** a retry with the same key reaches the payment's existing
  order, or creates it from the saved checkout.
  - A business reason the order cannot be created now (the payment is not
    confirmed, the saved checkout is unreadable, or the price or cart changed)
    answers "under review, do not pay again".
  - A transient error (the database briefly unavailable) answers 503: try
    again, do not pay again.
- **Server-side:** `CheckoutService.recoverFulfilment(paymentAttemptId,
  tenantId)` serves a recovery process or a support tool. It finds the payment
  within the given business only. Nothing calls it automatically yet: a
  sweeper and a support screen are ESP-03 PR 5.
- **Gift cards:** a charged gift-card purchase whose card was not issued is
  issued when the buyer retries, from the saved purchase row. Inside the
  issuing transaction the purchase row is locked and must not already have a
  card, so a concurrent issuance rolls back its own card entirely.

## Retention

| State | Saved checkout |
| --- | --- |
| Order created | Deleted in the same transaction. |
| Payment definitively declined or failed | Deleted (best effort; a leftover row can never become an order, because its payment never succeeded). |
| Charged, no order yet (under review) | Kept: it is the only way to create the order. Available to authorised server-side review only while the payment's case is open. |
| Payment held (unknown or awaiting confirmation) | Kept: needed if the payment is later confirmed. |
| Payment attempt created but never sent (a process stopped before charging) | Deleted when the customer retries more than 10 minutes after it was created. The customer is told nothing was charged and to start again; the attempt is never charged from a retry. Attempts nobody retries are left for the ESP-03 PR 5 sweeper. |

ESP-03 PR 5 (the resolver) must:
- delete the saved checkout when a case is resolved without an order
  (`REFUNDED_EXTERNALLY` or `NOT_CHARGED`);
- remove rows for never-sent attempts that nobody retried.

**Known limit until frozen pricing (ESP-03 PR 7):** the order is checked
against the amount charged as a total. A compensating change between two
prices can keep the total equal while individual line prices differ from what
the customer saw.

The rollback refuses while any saved checkout remains, so data still needed
for an order is never dropped.

## Access

- **Server-side only.** No API returns a saved checkout. Logs carry only
  payment ids and error class names, never the payload.
- **Tenant-owned.** Its payment attempt must belong to the same business (a
  composite foreign key). The standard ownership trigger stops a row from
  moving to another business.

## Tests

- `apps/api/src/payment/resumable-fulfilment.spec.ts` uses real database
  failures injected by triggers. It covers:
  - the checkout being saved before the charge, with no charge if it cannot
    be saved;
  - a decline clearing the saved checkout;
  - an order failure followed by a retry that ignores a tampered cart;
  - crash and database-interruption recovery with no flag and no case;
  - repeated and concurrent recoveries giving one order and a gift card spent
    once;
  - an existing order being returned;
  - lost commit acknowledgements for an order and for a gift card;
  - a transient error that answers 503, followed by a successful retry;
  - a never-sent attempt being cleared without a charge;
  - the pricing-change review path;
  - a held payment never being fulfilled;
  - tenant isolation;
  - gift-card issuance resume under concurrency.
- `apps/api/src/tenancy/checkout-snapshots-migration.spec.ts` covers the
  migration's bounds, keys, ownership trigger, preflight and rollback.
