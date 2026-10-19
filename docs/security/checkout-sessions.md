# Checkout sessions and server-generated payment keys (ESP-03 PR 6)

Every restaurant payment is bound to a checkout identity the server owns.
Clients never choose, send or see a payment key. This covers restaurant
customer payments only: food-order checkout and gift-card purchases.
CENTERIVO's own SaaS billing is separate and unchanged. No real payment
processor is connected.

## Food-order checkout

**The session**
- `POST /api/v1/orders/checkout-sessions` starts or resumes a
  `CheckoutSession`.
- A session belongs to one business, one location and, when signed in, one
  customer.
- The caller holds a random 256-bit token (`cs_…`). Only its SHA-256 hash is
  stored, so a database reader cannot use a session.
- It never charges. Resuming with a still-valid token:
  - reports a payment being confirmed as `IN_PROGRESS`;
  - reports a paid order as `COMPLETED`, with its confirmation, to the token
    holder only;
  - otherwise keeps the open session.
  - Any other token (another business's, another customer's, expired or
    unknown) starts a new session.

**Submitting** (`POST /api/v1/orders`) carries the token, never a key.
1. A request that still sends `idempotencyKey` is refused
   (`400 CLIENT_PAYMENT_KEY_NOT_ACCEPTED`) before anything happens.
2. The request body, the customer and the location are checked first, exactly
   as before.
3. The session must belong to this business, location and customer. If not,
   it is refused with one generic `409 CHECKOUT_SESSION_INVALID` that reveals
   nothing.

**Server-generated keys.** Each payment attempt gets a fresh key (`ck_…`,
256 random bits). The provider always receives the attempt's own key.

**One live payment per session.** A partial unique index allows at most one
attempt per session that is not definitively unsuccessful. That covers every
state in which a charge may be running, have succeeded, or be uncertain:
- not yet sent;
- charging;
- awaiting confirmation;
- unknown;
- succeeded;
- legacy NULL.

Attempt creation also locks the session row. Concurrent submissions
(double clicks, two tabs) therefore reach one attempt.

**Retries**

| Situation | What happens |
|---|---|
| Live payment, same checkout | The stored outcome is replayed through the existing PR 2–5 logic: the order, "being confirmed — do not pay again", or the recovery. Never a new charge. |
| Live payment, changed checkout, not yet completed | Refused with `CHECKOUT_CHANGED_DURING_PAYMENT`. The saved order is never updated, and no different order is ever returned. |
| Live payment, changed checkout, already completed | Refused with `CHECKOUT_ALREADY_COMPLETED`. |
| After a definitive decline or failure | The same session may be retried, edited or not, as one new attempt. |
| Uncertain outcome | Never allows a new charge. |
| Attempt saved but never sent, 10+ minutes old | Closed as `ABANDONED` (status `FAILED`), then the session continues. |

The abandon step is a conditional update from `NOT_SENT`, which the charge
claim also requires, so it can never race a real charge.

**The fingerprint.** HMAC-SHA256, keyed with the session's own token (which
is never stored), over the canonical, server-normalised, order-defining
checkout:
- the business, location and customer;
- the guest details as the order records them;
- every line, with its quantity and modifier choices (sorted);
- the reward, the coupon and the gift card.

It cannot be reversed from the database, even for a phone number, and it is
never logged.

Prices, discounts, the currency and the gift-card tender are server-computed
from those inputs and frozen in the saved checkout and the attempt's amount
(PR 4). They are not re-derived when comparing a retry. After a successful
charge, a used gift-card balance or a menu price change would otherwise make
a legitimate retry look like a different order.

**Session lifetime**
- New attempts are accepted for 24 hours.
- The token is recognised for replays for 7 days.
- Expiry deletes no payment record. Payment attempts, saved checkouts and
  reconciliation cases are kept on their own terms (PR 4 and PR 5). Support
  sees every unresolved payment in the Platform Console.
- Only sessions past their token lifetime that never had a payment attempt
  are removed: a small batch at a time, when new sessions start.

**Further safeguards**
- A customer's session stays a customer's (`customerBound`). If its customer
  were ever removed, it is refused, never treated as a guest session.
- A charge claimed long ago with no recorded outcome (the process stopped
  mid-charge) is never abandoned, because it may have been charged. It opens
  a `CHARGE_STRANDED` reconciliation case when its checkout is next used.
- A confirmed payment found without its order or saved checkout is flagged
  with a `FULFILMENT_FAILED` case, never left silent.
- A signed-in login that has not joined the restaurant gets a guest session.
  Placing the order still asks it to join or to choose guest. A restricted or
  deactivated profile never falls back to guest.

## Web storefront

- The token is never visible to browser JavaScript. This app's server keeps
  it in the `mh_checkout` cookie:
  - `__Host-` prefixed in production;
  - host-only, HttpOnly and Secure;
  - SameSite=Strict;
  - lasting 7 days;
  - holding one token per location, at most 5.
- `/api/checkout/session` and `/api/checkout` add it to the API calls they
  proxy. Both are protected by the existing origin and CSRF checks
  (`rejectUntrustedOrigin`).
- The checkout page starts or resumes its session on load. The session
  survives refreshes, closed tabs and interrupted responses.
  - A payment being confirmed pauses ordering, with "Check again".
  - A completed checkout whose confirmation was lost opens its confirmation:
    the order's access token goes into the HttpOnly guest-session cookie,
    never into page code.
- After a placed order, the cookie entry is dropped, so the next order is a
  new checkout. Repeat purchases, even identical ones, are always possible.
- An out-of-date page that still sends a key is told to refresh, and nothing
  is charged.

## Native clients (future)

The same API serves them without accepting client keys. A client calls
`checkout-sessions` and keeps the returned token in secure storage. It sends
the token in the checkout body and re-presents it to resume.

## Gift cards

- Step 1 (`purchase-intents`) generates the payment key on the server
  (`gc_…`). Every call establishes a new purchase, and nothing is charged
  until step 2.
- Step 2 (`purchase`) names the purchase by its `purchaseId`.
- The existing guest recovery credential, customer ownership checks, issuance
  lock and PR 5 recovery are unchanged. A purchase can never be charged or
  issued twice.

## Residual risks

- **Another device or browser, a cleared cookie, or a new private window.**
  These start an independent session. A retry made there cannot be told apart
  from an intentional new order without the cart, phone, amount or time
  heuristics that were ruled out. The held or completed payment of the
  earlier session is never touched: it is still recovered (PR 5) and visible
  to support.
- **A guest who signs in mid-checkout.** The guest session is bound to the
  guest, so the signed-in customer starts a new session.
- **The gift-card page.** It keeps the purchase reference and guest
  credential in memory, as before. A reload during a purchase loses them, and
  the buyer starts a new purchase. The earlier one was either never charged,
  or is recovered and its code retrievable through support guidance.
- **After the token's 7 days.** A token is no longer recognised for replays.
  A customer whose payment is still unresolved by then is pointed to the
  restaurant or support. Nothing is charged again automatically.

## Migration

`20261117090000_checkout_sessions` is additive:
- the `CheckoutSession` table;
- two nullable columns on `PaymentAttempt`;
- the partial unique index;
- the `paymentState` CHECK superset (`ABANDONED`, only with status `FAILED`).

It has a preflight. The rollback
(`prisma/rollbacks/20261117090000_checkout_sessions.down.sql`) refuses while
any session, session payment or abandoned attempt exists.
