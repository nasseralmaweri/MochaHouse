# Stripe payments (ESP-04 M3a)

Food-order checkout can take card payments through **Stripe PaymentIntents**,
in **Stripe test mode only**. Each payment is a **direct charge** on the
restaurant's own connected account (ESP-04 M1):

- the intent lives on that account;
- the restaurant pays Stripe's fees;
- CENTERIVO takes no application fee.

This milestone is the backend only. The web Payment Element is M3b.

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

## Not in M3a

- The Payment Element and 3-D Secure UI (M3b).
- Cancelling abandoned intents, and recovering unknown creations (M4).
  Until then, a waiting payment keeps its holds.
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
