# Restaurant payment accounts — Stripe Connect foundation (ESP-04 M1)

Each restaurant connects its **own** Stripe account to receive its customers'
payments. This milestone only connects and monitors that account; **no
customer payment can be taken**. CENTERIVO's own subscription billing is
separate and unchanged.

## Account model (decision A1)

- **Accounts v2.** Connected accounts are created with Accounts v2, the
  current API for new Connect platforms. It is GA in API version
  `2026-08-26.dahlia`, the version the pinned SDK (`stripe` 22.6.2) uses —
  the same one SaaS billing uses. No preview API is involved.
- **What we ask Stripe for:**
  - `dashboard: full` — the restaurant controls its own account in the
    Stripe Dashboard;
  - `defaults.responsibilities.fees_collector: stripe` — Stripe collects its
    processing fees from the restaurant's account;
  - `defaults.responsibilities.losses_collector: stripe` — Stripe, not
    CENTERIVO, covers negative balances it cannot recover;
  - `configuration.merchant` with the `card_payments` capability requested;
  - Stripe-hosted onboarding (Account Links, `account_onboarding` for the
    merchant configuration), which collects whatever Stripe requires.
- **Verified, not assumed.** Every read-back checks the dashboard, fee and
  loss responsibilities on the account itself. An account with any other
  configuration shows **Needs attention** (`CONFIGURATION_MISMATCH`) and is
  never treated as ready.
- **No platform fee (A2).** Nothing in this milestone charges or transfers
  money.

## Who may connect

- **Owner only.** The request needs the new `payments.connect` permission
  (corporate scope) **and** the business's built-in administrator role at
  corporate scope; the second is checked in the service, from the database.
  A custom role holding the permission is refused (`PAYMENT_ACCOUNT_OWNER_ONLY`).
- **Granting.** The migration grants `payments.connect` only to every
  business's built-in administrator role; new businesses get it at
  provisioning.
- **Audit.** Creating the account and opening onboarding are both recorded in
  the audit history (`payments.account_created`,
  `payments.onboarding_opened`), with the account id but never the
  onboarding link.

## One account per business, never a duplicate

1. Our `TenantPaymentAccount` record is created first. It is unique per
   business, and a concurrent request reuses it.
2. Stripe's account is created with the idempotency key
   `centerivo-connect-account-<record id>`. Retries, double clicks and
   concurrent requests therefore get the same account back.
3. When the account is first requested, before Stripe is called, the
   request time is recorded (`creationRequestedAt`). Within 23 hours a retry
   reuses the same idempotency key. After that (Stripe honours keys for at
   least 24 hours), an account whose id was never recorded is **not** created
   again automatically. The owner is told support must check it
   (`PAYMENT_ACCOUNT_NEEDS_SUPPORT`), and nothing is created.
4. The account id is recorded once, by a conditional update. A database
   guard refuses any later change of the account id, provider or mode, and
   refuses deletion. An account id is also unique across businesses.

**Owners who already use Stripe.** Accounts v2 offers no way to link a
pre-existing account (the OAuth flow belongs to the legacy Standard Connect
model). During hosted onboarding the owner signs in with their existing Stripe
login, and Stripe creates this restaurant's connected account under it.
CENTERIVO never creates a second account for the same business.

## Status comes from Stripe

The redirect back from onboarding (`?connect=return`) and expired links
(`?connect=refresh`) prove nothing. On return, on **Check status**, and on
every verified webhook, the account is read back with an authenticated
`v2.core.accounts.retrieve`. We store only what Stripe reports:

- dashboard, fee and loss responsibilities;
- the card-payments capability status;
- the soonest requirement deadline;
- the number of requirements awaiting the restaurant;
- whether the account is closed.

| State                  | When                                                              |
| ---------------------- | ----------------------------------------------------------------- |
| Not connected          | No account yet                                                    |
| Setup in progress      | Not read back yet, or Stripe needs information                    |
| Under review by Stripe | Nothing more is asked; card payments pending or restricted        |
| Action required        | Card payments restricted with items due, or requirements past due |
| Connected (`READY`)    | Card payments active **and** the approved configuration           |
| Not supported / Closed | As reported by Stripe                                             |
| Needs attention        | Configuration other than the approved one                         |

`paymentsEnabled` is always `false` in this milestone.

## Webhooks

- **Separate endpoint.** `POST /api/v1/restaurant-payments/webhooks/stripe`
  has its own signing secret, separate from SaaS billing's.
- **Signature only.** The provider's signature over the original raw body is
  the only credential. Unsigned or forged requests get 400 before anything is
  read or recorded.
- **No tenant context.** The route is excluded from the tenant middleware and
  rate limited.
- **Both event formats.** Classic events (`account.updated`) and v2 thin
  events (`v2.core.account.updated`, `v2.core.account[...]...`) are accepted.
  The SDK's `constructEvent` refuses thin events, so the SDK's own signature
  check is called directly.
- **Recorded once.** Each event is recorded once (unique per provider event
  id) with a SHA-256 digest of the body; the body itself is never stored. A
  duplicate delivery is a no-op.
- **Only account events are recorded.** Other event types are acknowledged
  but not stored, so the table cannot grow from unrelated traffic. The Connect
  endpoint should subscribe to account events only (launch gate).
- **Ignored, never acted on:** live-mode events and events naming an account
  that isn't ours. These are recorded with their outcome.
- **Business lookup.** The business comes from **our** stored account id,
  never from the event or its metadata.
- **Retries.** If Stripe cannot be read, the event is marked `FAILED` and the
  response is 503 so Stripe retries. A later delivery completes it.

## Configuration and isolation (A5)

| Setting                         | Meaning                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `RESTAURANT_PAYMENTS_PROVIDER`  | unset/`disabled` (default), `fake` (dev/tests), `stripe` (test mode)                           |
| `STRIPE_CONNECT_SECRET_KEY`     | `sk_test_…` / `rk_test_…` (a restricted key is recommended)                                    |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | `whsec_…` of the Connect webhook endpoint                                                      |
| `PAYMENTS_CONNECT_RETURN_URL`   | the admin Payments page (server configuration only; https outside local development and tests) |
| `PAYMENTS_CONNECT_COUNTRY`      | two-letter country, default `US`                                                               |

- **Refused at startup:**
  - a live key, in any mode;
  - `fake` or `stripe` in production, staging or live environments;
  - the SaaS billing key or webhook secret reused for restaurant payments.
- **Separate everything.** The module, tables, endpoint, permission and audit
  actions are all separate from SaaS billing (`saas-billing/`) and from the
  checkout's `PAYMENT_PROVIDER`; SaaS billing behaviour is unchanged.

## Data

- **`TenantPaymentAccount`** — tenant-owned, one per business:
  - test mode only (CHECK);
  - the staff member who connected it, via a composite foreign key;
  - never deleted.
- **`RestaurantPaymentProviderEvent`** — platform-level, because an event can
  name an account of no business here; ids, type, mode, account id, digest
  and outcome only.

Migration `20261120090000_restaurant_payment_accounts` is additive: one DO
block, a preflight and a 5s lock timeout. Its rollback refuses while any
record exists.

## Follow-ups

- **Retention.** A retention policy for processed and ignored Connect event
  records.
- **Stuck events.** A sweep for events stuck as received after a crash. Today
  they are re-driven only when Stripe retries the delivery.

## Not in this milestone

- Payments (M2–M3), reconciliation (M4), refunds (M5) and gift cards (M6).
- Live mode (M7, separate approval).
- Disconnecting an account.
- Testing against a real Stripe test account. That needs the owner's test-mode
  keys and a Connect webhook endpoint, and is part of the M7 launch gates.
  This milestone is verified offline: the SDK's request shapes and signature
  helpers, and a deterministic fake.
