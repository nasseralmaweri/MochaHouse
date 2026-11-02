# Two-step checkout payments (ESP-04 M2)

Food-order checkout can now take a payment in two steps, the way a real card
processor does (Stripe PaymentIntents, ESP-04 M3):

1. The server creates a **payment intent** for the frozen amount.
2. The customer confirms it in the browser.
3. The server **reads the outcome from the provider** and only then creates
   the order.

The browser's word is never evidence of payment. No real processor is
connected in M2. The two-step path runs only with the development provider
`PAYMENT_PROVIDER=fake-two-step`, which is refused at startup in any
production-like environment. The default stays "online payment unavailable".

Unchanged:

- the one-step fake (`PAYMENT_PROVIDER=fake`) and every existing test
  provider;
- zero-charge orders;
- gift-card purchases (they keep the one-step charge until ESP-04 M6);
- SaaS billing.

## Provider interface v2

`PaymentIntentProvider` (`packages/integrations`):

| Operation               | Purpose                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `createPaymentIntent`   | Amount, currency, the server-resolved account, and the attempt's key as the idempotency key |
| `retrievePaymentIntent` | The provider's authoritative status                                                         |
| `clientSecretFor`       | What the browser needs to confirm, fetched fresh on every answer                            |
| `cancelPaymentIntent`   | Interface only. ESP-04 M4 uses it                                                           |

Status vocabulary:

- `succeeded`, with the amount and currency actually taken
- `requires_customer_action`
- `requires_payment_method`: refused, but retryable on the **same** intent
- `processing`
- `canceled`
- `failed` (creation only): the provider definitively refused before any
  intent existed. An adapter must never map a timeout, a network error, a 5xx
  or any answer after which an intent might exist to `failed`: those are
  `unknown` (held, never released). The M3 Stripe adapter must uphold this.
- `unknown`

The account context (`tenantId` and the connected account from ESP-04 M1)
always comes from the server's records of the business, never from a
request. Client secrets are never stored or logged.

Checkout uses two steps only when the configured provider implements this
interface. Every other provider keeps the one-step `chargeAttempt` path,
byte for byte.

## The new payment state

`REQUIRES_CUSTOMER_ACTION` (migration `20261121090000_payment_customer_action`)
means the intent exists and waits for the customer.

- It is **live** (`status = PENDING`). The checkout session's
  one-live-payment index keeps it the session's only payment, so a reload, a
  retry or a lost response resumes the same intent and never creates another.
- A CHECK constraint makes it always `PENDING` with a `providerReference`.
- It is **not** a held or unknown outcome (CHARGING, AWAITING_CONFIRMATION,
  UNKNOWN): the customer just hasn't finished paying.
- Its financial holds (ESP-03 PR 8) stay ACTIVE. The release trigger only
  acts on DECLINED / FAILED.

The migration is additive: it widens the paymentState CHECK and adds one
CHECK. Rollback: `prisma/rollbacks/20261121090000_payment_customer_action.down.sql`.
The rollback refuses while any payment waits for its customer.

## Flow

| Step                       | Outcome                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| Claim                      | NOT_SENT → CHARGING (conditional, committed before the provider is called)   |
| Create → requires action   | `REQUIRES_CUSTOMER_ACTION` + reference; `202 PAYMENT_REQUIRED`               |
| Create → succeeded         | SUCCEEDED; the order (`201`). A different amount or currency: UNKNOWN (held) |
| Create → failed / canceled | FAILED; holds released; `402`                                                |
| Create → processing        | AWAITING_CONFIRMATION (held, reconciliation case); `409`                     |
| Create → unknown / timeout | UNKNOWN (held, reconciliation case); `409`, never retried                    |

`POST /api/v1/orders` answers either:

- `201` with the order (unchanged), or
- `202` with `CheckoutPaymentRequiredResponse`: provider, state, client
  secret (null for the fake), amount and currency. It never includes the
  provider's reference or our ids.

### Checking

`POST /api/v1/orders/checkout-sessions/payment` takes `{ locationId, checkoutToken }`.

- It retrieves the intent from the provider.
- It moves the attempt only from `REQUIRES_CUSTOMER_ACTION` or (a
  two-step payment the provider is processing) `AWAITING_CONFIRMATION`, by a
  conditional update.

| Provider says              | Attempt                                                                  | Holds    | Answer                                |
| -------------------------- | ------------------------------------------------------------------------ | -------- | ------------------------------------- |
| succeeded (frozen amount)  | SUCCEEDED, then the order, exactly once                                  | consumed | `200` order                           |
| succeeded (other amount)   | unchanged; reconciliation case                                           | kept     | `409`                                 |
| requires_customer_action   | unchanged                                                                | kept     | `202`                                 |
| requires_payment_method    | unchanged (try again on the same intent)                                 | kept     | `202` `REQUIRES_PAYMENT_METHOD`       |
| processing                 | AWAITING_CONFIRMATION; reconciliation case                               | kept     | `202` `PROCESSING` (no client secret) |
| canceled                   | FAILED (no charge can occur any more); an open case resolves NOT_CHARGED | released | `402`                                 |
| failed / unknown / error   | unchanged                                                                | kept     | `409` (not known yet)                 |
| another intent's reference | unchanged                                                                | kept     | `409`                                 |

Concurrent checks of a paid intent:

- One wins the conditional update.
- The others re-read the attempt and replay the same order; the order
  transaction locks the attempt row.

The result is exactly one order, one fulfilment and one consumption of the
holds.

A retried `POST /orders` for a waiting payment performs the same check. So
does a reload: the session reports `PAYMENT_REQUIRED`, and the page asks
where the payment stands.

## The development simulator

`POST /api/v1/orders/checkout-sessions/payment/simulate` takes
`{ locationId, checkoutToken, outcome }`, where `outcome` is one of
`succeed`, `decline`, `process`, `cancel` or `unknown`.

It plays the customer's part with the two-step fake. It returns `404
PAYMENT_SIMULATION_NOT_AVAILABLE` unless both hold:

- the configured provider is the two-step fake;
- no production-like signal is present.

The web route also refuses it in a production build.

It never names an amount, a payment or an account, and it records nothing.
The outcome is still read back from the provider by the check endpoint. A
paid or cancelled fake intent never changes.

## Authorization and abuse

- Every endpoint is bound to the checkout session: this business, this
  location, this customer (or guest). Anything else gets one generic
  refusal.
- The session token stays in the HttpOnly cookie. The browser sends only a
  location, plus an outcome for the simulator.
- The web routes refuse cross-site requests (`rejectUntrustedOrigin`).
- The check and the simulator are rate limited with the `checkout` policy.
- Responses are `no-store`.
- Customer-facing messages are fixed text. Provider text, references and
  secrets never appear in responses or logs.

## Web

`/api/checkout` passes a `202` through and keeps the checkout-session cookie.
Only a placed order ends the checkout in the browser.

New routes:

- `/api/checkout/payment` (check);
- `/api/checkout/payment/simulate` (development only).

The checkout page shows a payment panel while a payment waits, with
**Check payment status** and, in development with the two-step fake, the
simulator buttons. A reload resumes the same payment.

## Not in M2

- Stripe PaymentIntent creation, the Payment Element and webhooks (M3).
- Automated cancellation or expiry of abandoned intents (M4). A waiting
  payment keeps its holds until it is paid or cancelled.
- Gift-card purchases on intents (M6).
