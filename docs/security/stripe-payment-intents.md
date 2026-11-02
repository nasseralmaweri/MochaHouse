# Stripe payments (ESP-04 M3a, M3b)

Food-order checkout can take card payments through **Stripe PaymentIntents**,
in **Stripe test mode only**. Each payment is a **direct charge** on the
restaurant's own connected account (ESP-04 M1):

- the intent lives on that account;
- the restaurant pays Stripe's fees;
- CENTERIVO takes no application fee.

M3a is the backend. M3b is the customer's card form (the Stripe Payment
Element) on the checkout page, described in
[The checkout page (M3b)](#the-checkout-page-m3b).

Everything is **off by default**. Nothing changes unless `PAYMENT_PROVIDER=stripe`
is set with a valid test configuration **and** the business is on the test
allowlist.

Unchanged:

- the two-step state machine (ESP-04 M2), financial holds and exactly-once
  fulfilment;
- the fakes and every other provider;
- CENTERIVO's SaaS billing, which shares no key, secret, endpoint or table.

## Configuration

| Setting                                    | Meaning                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `PAYMENT_PROVIDER=stripe`                  | Stripe PaymentIntents (test mode)                                                                 |
| `RESTAURANT_PAYMENTS_PROVIDER=stripe`      | Required. Its `STRIPE_CONNECT_SECRET_KEY` (test key) creates the intents on the connected account |
| `STRIPE_CONNECT_PUBLISHABLE_KEY`           | `pk_test_…`, sent to the browser with the connected account id                                    |
| `STRIPE_CONNECT_PAYMENTS_WEBHOOK_SECRET`   | `whsec_…` of the payment-events endpoint. Never the account-events or SaaS billing secret         |
| `RESTAURANT_CHECKOUT_PAYMENT_TENANTS`      | Comma-separated business ids allowed to take test payments. **Empty: none**                       |
| `RESTAURANT_PAYMENT_EVENT_REDRIVE_ENABLED` | `1` re-processes unfinished payment events in the background. **Off by default**                  |

Refused at startup:

- a live secret or publishable key, in any mode;
- `stripe` in production, staging or live environments;
- any missing or malformed value above;
- a reused SaaS billing key or secret, or the M1 account-events secret;
- a malformed allowlist entry.

Gift-card purchases are refused while Stripe is selected. They keep the
one-step charge until ESP-04 M6.

## Who may start a payment (D1)

Before any payment attempt, saved checkout or hold exists, all of these must
hold:

- the business is on the allowlist;
- its connected account is **READY** as last read back from Stripe, in test
  mode;
- the charge is in US dollars and at least 50¢.

Otherwise checkout answers "online payment is not available" and records
nothing.

## Creating the intent

- **Request.** Amount and currency from the frozen checkout, cards only,
  automatic capture.
- **Account.** The `Stripe-Account` header is the business's connected
  account, from our records only. The same account is stored on the payment
  (`providerAccountId`) with the charge claim, before Stripe is called.
- **Idempotency.** The payment's own server-generated key is the Stripe
  idempotency key, so a retry, reload or lost response resumes the same
  intent.
- **Metadata.** Only our payment and business ids. Never contact details,
  and no Customer object, receipt email or saved card.

### What creation can answer (safeguard 1)

| Outcome                                                                                             | Result                                                                             |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Refused **locally** before anything is sent (no account, currency, amount, not allowlisted)         | `failed`: definitively nothing charged, holds released                             |
| A valid test-mode intent for exactly the requested amount and currency                              | Its state (below)                                                                  |
| **Any** Stripe error: 400, 401, 403, idempotency conflict, 409, 429, 5xx, connection error, timeout | `unknown`: held, holds kept, reconciliation case, a fixed code (`stripe_create:…`) |
| A live, malformed or mismatched answer                                                              | `unknown` (its reference kept when it has one)                                     |

A Stripe error is never proof that no intent exists: an SDK retry, a key
replay or a race may have created one. Recovering unknown creations is
ESP-04 M4.

## Stripe states

| Stripe                                                                       | Meaning                                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `requires_payment_method`, no previous error                                 | A **new** intent waiting for its card (`REQUIRES_CUSTOMER_ACTION`)                                |
| `requires_payment_method` with a `last_payment_error`                        | Refused; may be retried on the **same** intent                                                    |
| `requires_confirmation`, `requires_action`                                   | Waiting for the customer (3-D Secure)                                                             |
| `processing`                                                                 | Held (`AWAITING_CONFIRMATION`, case)                                                              |
| `succeeded`                                                                  | Paid, only if `amount_received` and currency equal the frozen checkout. Otherwise held for people |
| `canceled` with nothing received                                             | Closed; holds released                                                                            |
| `canceled` with money received, `requires_capture`, anything else, live mode | Unknown: held                                                                                     |

New transition: a `processing` payment that later comes back as
`requires_payment_method` (its card refused after all) waits for its customer
again on the same intent. A SYSTEM event `PROVIDER_REQUIRES_PAYMENT_METHOD`
is added to its case.

Every read is made on the account stored on the payment. If that no longer
matches the business's account, nothing is read and the payment stays held.

## The 202 answer (D5)

When a payment waits for its customer, the answer adds two fields:

- `publishableKey`: the platform's test key;
- `connectedAccountId`: the account the intent lives on.

Both come from server configuration and records. The client secret is still
fetched from Stripe for each answer and never stored or logged. The browser
still sends only a location.

## Payment webhooks (B1, D6)

`POST /api/v1/restaurant-payments/webhooks/stripe/payments`

- **Its own signing secret and rate limit.** Separate from the M1
  account-events endpoint and from SaaS billing.
- **Signature only.** Stripe's signature over the original raw body is the
  only credential. Unsigned or forged requests get 400.
- **No tenant context.** Excluded from the tenant middleware (the
  restaurant-payments webhooks prefix).
- **Events handled:** `payment_intent.succeeded`, `.processing`,
  `.payment_failed`, `.canceled`, `.requires_action`. Anything else is
  acknowledged and not recorded.

### Linking: never from metadata

1. The event's `account` must be one of **our** connected accounts, which
   gives the business. Otherwise: `IGNORED / UNKNOWN_ACCOUNT`.
2. That business's Stripe payment for **that intent on that account**.
   Otherwise: `UNMATCHED / NO_MATCHING_PAYMENT`. The event is kept, with its
   account and intent, for reconciliation (M4). Nothing is linked.
3. The intent is **read back from Stripe** on the payment's stored account.
   The event body's status is never used.
4. A paid payment's order is created from its saved checkout, exactly once,
   through the same locked path every retry and recovery uses.

An event that names none of our payments and carries no CENTERIVO metadata
is acknowledged and not stored. These are a restaurant's own Stripe sales.
Live-mode events are `IGNORED`.

### Crash-safe acknowledgement (safeguard 2)

- **Recorded first.** An event is recorded once (unique per event id) before
  it is processed.
- **2xx only when finished.** The answer is 200 **only** once the event is
  `PROCESSED`, `IGNORED` or `UNMATCHED`. Anything else answers **503**, so
  Stripe delivers it again.
- **Unfinished is never skipped.** An event left `RECEIVED` (a crash) or
  `FAILED` (an error) is processed again by the next delivery. That includes
  a **concurrent** duplicate delivery: it is never acknowledged while the
  first one is unfinished.
- **Idempotent processing.** Processing is reads, conditional updates and the
  locked fulfilment. Redeliveries, races with the customer's own check, and
  re-drives produce one order, one fulfilment and one consumption of holds.
- **Bounded.** The Stripe read is limited to 8 seconds.
- **Payments only "settled" when durable.** An event is `PROCESSED` once the
  payment's outcome is durably recorded: paid with its order, closed, still
  waiting, still processing, or held for people with a case. A payment that
  could not be read, or whose order could not be written and was not flagged
  for review, leaves the event `FAILED` (503).

### Re-drive (off by default)

With `RESTAURANT_PAYMENT_EVENT_REDRIVE_ENABLED=1`, unfinished payment events
are processed again in the background from what was stored (account, intent,
type):

- older than 2 minutes;
- batches of 20, every minute;
- exponential backoff (1 to 60 minutes);
- at most 8 attempts.

Concurrent re-drives are harmless because processing is idempotent. Whether
or not it runs, an unfinished event is never acknowledged.

### The M1 account-events endpoint

Two changes to `handleEvent`:

- It now checks the event type **first**, so it never touches a payment event
  in the shared table.
- A concurrent duplicate delivery is no longer acknowledged while the first
  is unfinished. It processes the event itself (the account is simply read
  back again).

## Data

Migration `20261122090000_stripe_payment_intents` is additive:

- **`PaymentAttempt.providerAccountId`** (`acct_…` CHECK):
  - a Stripe payment that names an intent always names its account (CHECK);
  - at most one Stripe payment per intent (partial unique index);
  - once recorded, a Stripe payment's account, intent and provider never
    change (trigger guard).
- **`RestaurantPaymentProviderEvent`:**
  - `externalObjectId` (`pi_…` CHECK) and `lastAttemptAt`;
  - status `UNMATCHED`;
  - an index on `(status, receivedAt)`.
- **Preflight.** Refuses if applied twice or if Stripe payments already
  exist.

Rollback: `prisma/rollbacks/20261122090000_stripe_payment_intents.down.sql`.
It refuses while any Stripe payment or payment event exists.

## Verified offline

The real adapter runs against an in-memory stand-in for the PaymentIntents
API, with Stripe's idempotency rules. Webhook signatures use the SDK's own
helpers. No Stripe call is made, and no key or webhook is configured.

## The checkout page (M3b)

When the server answers `202 PAYMENT_REQUIRED` for a Stripe payment, the
checkout page shows a card form: the Stripe **Payment Element**
(`@stripe/react-stripe-js` 6.12.0 with `@stripe/stripe-js` 9.17.0, pinned).
These load Stripe.js `dahlia`, the release that matches the server's API
version `2026-08-26.dahlia`.

### Initialisation: only what the server gave

- **Lazy.** Stripe.js is loaded from `js.stripe.com` only when the form is
  shown (the "pure" loader), never on other pages.
- **From the 202 answer only.** It is initialised with that answer's
  `publishableKey` and `connectedAccountId` (the account the intent lives
  on). The form is mounted with that intent's `clientSecret`.
- **Refused otherwise.** The page uses no form for:
  - another provider;
  - a payment that is processing;
  - a live or non-publishable key;
  - a missing or malformed account or secret.
  It then says the form couldn't load and that nothing was charged.
- **One Stripe.js instance per connected account.** The form is keyed by
  account and intent, so it is never reused for another payment, checkout or
  business.
- **Nothing sent back.** The browser still sends only a location to the
  server, never an account, an amount or an intent.
- **Cards only.** The intent allows nothing else, and Apple Pay and Google
  Pay are switched off in the form. No Link, no other methods.
- **Theme.** The form follows the storefront's theme tokens (accent,
  surfaces, text, error colour, control radius).

### Paying

1. **Pay [amount].** The button is enabled once the card form is complete. A
   second press, or a double click, does nothing while a payment is being
   confirmed or checked.
2. **Confirm.** `stripe.confirmPayment({ redirect: "if_required" })`. 3-D
   Secure runs in Stripe's own frame. If the bank requires a redirect,
   Stripe returns the customer to `<this origin>/order/checkout?payment=return`.
   That URL is built from the browser's own location.
3. **Server check, always.** Whatever Stripe.js answers, the page then asks
   CENTERIVO's server (`/api/checkout/payment`). The server reads the intent
   from Stripe and alone creates the order, exactly once. A Stripe.js
   "succeeded" is never treated as paid.

| Stripe.js answers                                | The page                                                     |
| ------------------------------------------------ | ------------------------------------------------------------ |
| No error (paid, or waiting for a bank)           | Asks the server                                              |
| `card_error` (declined)                          | Shows Stripe's message, asks the server; retry on the same intent |
| `validation_error` (form incomplete)             | Asks the customer to fix the card form; nothing was sent     |
| Any other error, or no answer                    | Asks the server; never shown as failed                       |

### What the customer sees

| Server says                 | Page                                                                    |
| --------------------------- | ----------------------------------------------------------------------- |
| Waiting for a card          | Card form, Pay button                                                   |
| Refused                     | "Didn't go through … you won't be charged twice", form for another card |
| Processing                  | No form, "do not pay again"                                             |
| Not known yet (`409`)       | The existing held-payment message; never "failed"                       |
| Paid                        | The order confirmation                                                  |
| Cancelled (`402`)           | "Not successful"; the checkout can be placed again                      |
| Session expired or invalid  | The existing session messages                                           |

### Refresh and return from the bank

- **Refresh resumes the same payment.** The checkout session (HttpOnly
  cookie, unchanged) reports `PAYMENT_REQUIRED`. The page asks the server
  and shows the same intent's form again, never a second intent. The cookie
  is cleared only when the order is placed.
- **Return parameters removed.** On return from a bank redirect, the
  parameters Stripe adds (`payment_intent`, `payment_intent_client_secret`,
  `redirect_status`, and our `payment=return`) are never read. They are
  removed twice:
  - **on the server**, before any page renders: the web proxy answers
    `303` to the same checkout page without them, with
    `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. The secret
    never reaches a rendered document, its scripts or a Referer;
  - **in the page**, as a fallback, with `history.replaceState`.

  The one returning request still carries them, as Stripe sends it, so
  access logs in front of the web app should not record query strings for
  `/order/checkout` (deployment item, M7).
- **Busy state.** While a card payment is being confirmed, the page's other
  payment actions ("Check payment status", the development simulator) are
  paused. The check after confirming waits for any check already running and
  then makes a fresh one, so the page always shows the server's answer from
  **after** the confirmation. A failed check never leaves the page stuck.
- **No storage.** The client secret lives in memory only: never stored,
  logged or sent anywhere but Stripe.js.

### Headers

- `/order/checkout` now gets `Referrer-Policy: no-referrer` and
  `Cache-Control: no-store`, like the order confirmation page.
- The global headers are unchanged:
  - `X-Frame-Options: DENY` and `frame-ancestors 'none'` govern who may frame
    **this** page, not Stripe's frames inside it;
  - no full CSP is set;
  - `Permissions-Policy: payment=()` stays, because card payments need no
    Payment Request permission. Wallets would.

### Unchanged

- The development two-step simulator (fake provider, development only).
- Zero-charge orders, coupons, rewards and gift cards.
- The cart and order summary.
- Checkout-session recovery, the confirmation page and every existing error
  message.
- SaaS billing.

### Verified offline

Stripe.js is mocked in the web tests: initialisation, per-account instances,
confirmation outcomes, duplicate presses, return-URL clean-up, headers and
the 202 parsing. No real Stripe call is made.

## Outcome recovery (M4a)

A Stripe payment whose outcome is not known is recovered from Stripe itself
by the existing payment-recovery sweeper. This covers CHARGING (a crash
after the claim), UNKNOWN (a timeout, a connection error, a 409, 429 or 500,
or a lost database write) and AWAITING_CONFIRMATION (processing). Details
are in [payment-reconciliation.md](payment-reconciliation.md#stripe-outcome-recovery-esp-04-m4a).

- **The intent is known.** It is read back on the payment's stored account
  and the payment moves only on Stripe's answer:
  - paid, for the frozen amount and currency, gets its order exactly once;
  - waiting for a card makes the payment live again on the same intent;
  - processing stays held;
  - cancelled with nothing received releases the holds;
  - a different amount is held for people.
- **No intent recorded.** The creation is **replayed**: the same idempotency
  key, the same connected account and byte-identical parameters (one shared
  builder). This happens only **within 20 hours** of the payment's creation,
  because Stripe keeps keys "at least 24 hours" and reusing a pruned key is a
  new request. The replay finds the intent Stripe created, or creates it for
  the first time if the original never arrived.
  - **Proves nothing, changes nothing:** a cached 500, a conflict, a local
    refusal or a timeout.
  - **Set aside for people, holds kept:** a key Stripe refuses with these
    parameters, an intent that already belongs to another payment, or any
    payment past the window.
- **Events that arrived first.** A Stripe event that came before its payment
  recorded the intent (`UNMATCHED`) is reconciled by the sweep through the
  same idempotent path once the payment names that intent. Re-drive does not
  need to be on, and no redelivery is needed. Linking only ever goes through
  our records, never through an event's metadata.

## Not in M3 / M4a

- Cancelling abandoned intents (M4b). Until then, a payment waiting for its
  customer keeps its holds.
- Refunds (M5). Gift cards on intents (M6). Live mode (M7).
- Wallets, Link and other payment methods (B4: cards only).

## Before any real test-mode run (owner, Stripe Dashboard)

1. A test connected account onboarded to READY through M1.
2. Card payments enabled for connected accounts.
3. The platform's test publishable key.
4. A "Connected accounts" event destination for the five `payment_intent.*`
   events, pointing at the endpoint above. Its secret goes in
   `STRIPE_CONNECT_PAYMENTS_WEBHOOK_SECRET`. Locally:
   `stripe listen --forward-connect-to …/webhooks/stripe/payments`.
5. Confirm in test mode that `payment_intent.*` events from Accounts v2
   connected accounts reach that destination.

### Manual test-mode end-to-end run (needs owner approval)

Not done by M3a or M3b, and nothing here is switched on by them. With the
setup above, on a local or test environment (never production):

1. **API settings.**
   - `PAYMENT_PROVIDER=stripe` and `RESTAURANT_PAYMENTS_PROVIDER=stripe`;
   - the Connect test key and both webhook secrets;
   - `STRIPE_CONNECT_PUBLISHABLE_KEY`;
   - `RESTAURANT_CHECKOUT_PAYMENT_TENANTS=<the test business id>`.
2. **Forward events.** Run
   `stripe listen --forward-connect-to http://localhost:3001/api/v1/restaurant-payments/webhooks/stripe/payments`
   and use the secret it prints.
3. **Check each case** on the storefront with Stripe's test cards:
   - `4242 4242 4242 4242`: paid, one order;
   - `4000 0025 0000 3155`: 3-D Secure challenge;
   - `4000 0000 0000 9995` (declined), then a good card on the same payment;
   - `4000 0000 0000 0341` (declined after attaching).
4. **Interruptions.** Also check:
   - a page refresh mid-payment;
   - closing the tab after paying (the webhook creates the order);
   - a redirect return (Stripe's parameters must leave the URL).
5. **Verify** in Stripe's test Dashboard that each charge is on the
   **connected account**, for the frozen amount, with no application fee.
6. **Check the referrer policy.** Confirm Stripe.js and 3-D Secure work with
   the checkout page's `Referrer-Policy: no-referrer`. If Stripe needs a
   referrer, `strict-origin` would still never send the URL's query string.
7. **Turn it all off afterwards.** Unset `PAYMENT_PROVIDER` and empty the
   allowlist.
