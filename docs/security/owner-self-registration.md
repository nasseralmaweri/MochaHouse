# Business owner self-service registration (SC4a)

Status: implemented behind configuration. **Off everywhere**
(`SELF_SERVICE_REGISTRATION_ENABLED` unset). Turning it on in any real
environment needs the AWS changes below, the legal documents and the
migration applied — each requires explicit owner approval.

## What it does

A business owner proves their email with a code, sets their own password and
accepts the Terms of Service and Privacy Policy. The result is a **staff-pool
login** and a platform `OwnerRegistration` record (status `VERIFIED`, legal
versions, timestamp, the login's subject), plus a
`platform.owner_registration.verified` audit event.

It creates **no business, staff member, role or permission**. SC4b (separately
approved) creates the business and binds its first owner to the recorded
login by subject.

| Route | |
|---|---|
| `GET /api/v1/internal/registration` | `{ enabled: false }`, or the legal versions/links to show |
| `POST /api/v1/internal/registration/start` | `{ email }` → always `202 CODE_SENT_IF_ELIGIBLE` |
| `POST /api/v1/internal/registration/complete` | `{ email, code, password, displayName, termsVersion, privacyVersion, acceptLegal }` → `200 VERIFIED` |

`start` and `complete` answer **404** unless registration is enabled, checked
by the API on every request. Web: `/internal/register` (404 while disabled) and
a "Create an account" link on `/internal/sign-in` only while enabled.

## Security properties

- **No account claiming by email.** A login recorded in `OwnerRegistration`
  is never bound to an existing staff row by email
  (`unbound-email-match.ts`); it can only be bound by subject. Registering
  with a staff member's address gives no access to their business.
- **Existing logins are never touched.** If a login with that email already
  exists, nothing is recorded against it, no code is sent and it cannot be
  completed through registration.
- **No pre-hijacking.** A login starts with a server-only initial password
  (HMAC of `SELF_SERVICE_REGISTRATION_SECRET` and a per-registration random
  nonce, never sent to a browser). The owner's own password is set only in
  the same request as a correct code. A sign-up code confirmed earlier is
  **never** accepted again: an interrupted completion is finished with a new
  password-setup code.
- **The recorded login is fixed.** The subject comes only from the identity
  provider's answer to creating the login, never changes, a `VERIFIED`
  registration is final, and a registration with a login is never deleted
  (database trigger). Before `VERIFIED`, a real sign-in with the new password
  must return exactly that subject with a provider-verified email.
- **No platform privileges.** Platform operators are a separate pool,
  verifier and table; registration never reads or writes them.
- **No enumeration.** `start` answers the same whatever the email's state;
  every code problem in `complete` gets the same answer. (Response timing is
  not equalised; see residual risks.)

## Limits

| Limit | Value |
|---|---|
| Rate limit `owner-registration` (start) | 3/h per email+IP, 10/h and 20/24 h per IP, 6/h per email |
| Rate limit `owner-registration-verification` (complete) | 5/15 min per email+IP, 20/15 min per IP, 30/h per email |
| Codes per email | 5 per rolling 24 h (further starts answer the same, send nothing) |
| Attempts per code | 5; a new code resets them |
| Code acceptance | 24 h after sending (the provider's own expiry also applies) |
| New registrations, all emails | `SELF_SERVICE_REGISTRATION_DAILY_LIMIT` per rolling 24 h (default 50); while used up, every start is a 503 |

There is no CAPTCHA yet. If abuse warrants one, it goes on `start` only (the
route that sends email), checked before the service runs.

## Configuration

| Variable | |
|---|---|
| `SELF_SERVICE_REGISTRATION_ENABLED` | `1` or `true` to enable; anything else is off |
| `SELF_SERVICE_TERMS_VERSION`, `SELF_SERVICE_PRIVACY_VERSION` | required; the versions shown and recorded |
| `SELF_SERVICE_TERMS_URL`, `SELF_SERVICE_PRIVACY_URL` | optional https links |
| `SELF_SERVICE_REGISTRATION_SECRET` | required, at least 32 characters; never rotate while registrations are pending |
| `SELF_SERVICE_REGISTRATION_DAILY_LIMIT` | optional, default 50 |
| `INTERNAL_COGNITO_REGISTRATION_CLIENT_ID` / `_SECRET` | the dedicated registration app client (production) |

A required value that is missing or malformed keeps registration **off**.

## AWS prerequisites (separate approval; nothing here is applied by code)

Registration uses the existing **staff** Cognito pool through a **dedicated,
confidential** app client, with provider-level controls so the public staff
sign-in client can never be used to self-register around the API:

1. A new app client for registration **with a client secret**,
   `ALLOW_USER_PASSWORD_AUTH` enabled, email as the only writable attribute.
   Only the API holds the secret.
2. A **Pre sign-up Lambda trigger** that rejects every `PreSignUp_SignUp`
   whose `callerContext.clientId` is not the registration client, never
   auto-confirms and never auto-verifies email. `PreSignUp_AdminCreateUser`
   (operator-created staff) stays allowed.
3. Only after 1 and 2 are live: allow self sign-up on the pool
   (`AllowAdminCreateUserOnly = false`).
4. The pool's password policy must be no stricter than the API's (12+
   characters, upper, lower, digit, symbol), and the sign-up and
   forgot-password messages should be worded for owner registration.

Until all of this is in place, keep `SELF_SERVICE_REGISTRATION_ENABLED` off.

## Residual risks

- Without the Pre sign-up trigger, anyone could create a staff login through
  the public client, bypassing the flag and limits. It would not be recorded
  as a registration, so — like an operator-created login — it could be bound
  by email to a staff row provisioned for that same address. Verifying it
  still requires that mailbox's code. This is why the trigger is mandatory.
- **Quota exhaustion.** The global daily quota is a circuit breaker: starts for made-up addresses from several IPs (20 per IP per day) can use it up and pause registration for everyone for up to 24 h. Five starts for one address use up that address's code allowance for 24 h. A CAPTCHA on `start` (deferred, D6) is the fix if this is abused.
- Response timing differs slightly between email states (for example, `complete` for an address whose login already existed answers faster), which can reveal whether a staff login exists for an address.
- Staff-pool password reset for owners is not part of SC4a.

Resolved in SC4b: an interruption between creating the login and recording
its subject no longer leaves the email stuck. The next start or completion
recognises the login as ours only by signing in with the server-only initial
password, and records its subject from that real sign-in; anyone else's
login is never touched.

## SC4b — the owner creates their business

After registering, the owner signs in. A verified self-registered owner with
no business gets a **restricted onboarding session** (B2): its own HttpOnly
cookie, never read by `/admin`, admitted by the API only to
`GET /api/v1/internal/onboarding` and `POST /api/v1/internal/onboarding/business`
(`InternalIdentityGuard`: a verified login, no business, no staff row, no
permissions). Operator-created staff logins have no registration and are
never eligible (B4). The routes are 404 while registration is off.

Creating the business (one `TenantProvisioningService` transaction, B3):
the business (ACTIVE, automatic slug), its built-in roles, the owner bound
to **their own login by subject** (never by email), the billing contact,
history with source `OWNER`, a `platform.tenant.self_provisioned` audit event
naming the login (no operator anywhere), and `OwnerRegistration.provisionedTenantId`
— unique and immutable, so one business per owner; retries and concurrent
requests return the same business.

**Plan and price (B1).** Only plans an operator marked "offered for
self-service" (never Founding), at their newest published version and ACTIVE
prices. The owner's request carries the plan version, price, interval,
currency and amount they saw; any difference is refused (409) — never
substituted.

**Payment setup pending (B1).** The subscription is `BILLED` at that price
with no billing-provider customer yet (the narrowest relaxation of
`TenantSubscription_billed_check`: exactly this state, nothing authorized,
started or owed). Until the provider verifies billing or a trial, the
business has **core only** — no plan modules and no operator add-ons (kept, not
deleted; they apply again once billing is verified) — and **no customer
sales** (checkout refuses with `SALES_NOT_AVAILABLE`), whatever the billing
enforcement switch says. After provisioning, the web app moves the owner to
a normal session only once the API admits the login to that business
(`GET /internal/me`). Operator-created or operator-billed businesses keep the
existing rules. Payment setup itself opens with SC4c.

Operators offer or withdraw a plan for self-service in the Platform Console
(Plans), audited as `platform.plan.self_service_changed`.

## SC4c — the first payment setup

After creating the business the owner lands on Billing ("Set up payment
now"), which also stays there to resume later. It uses the existing owner
Checkout (`POST /api/v1/admin/billing/checkout`): one open Checkout per
business, deterministic idempotency keys, the existing one-trial-per-owner
rules, activation only from verified provider events.

- **Provider customer (C1)** — created only when payment setup starts. An
  interrupted earlier attempt is reconciled first (the provider is asked for
  a customer already made for this business), then a customer is created with
  the subscription's deterministic idempotency key, and recorded with a
  compare-and-set: retries, concurrent clicks and timeouts converge on one.
- **Exact price** — Checkout is for the subscription's chosen price. If that
  price was retired or the plan withdrawn (C4), setup is refused
  (`BILLING_SELECTION_UNAVAILABLE`) and the owner chooses again — never
  substituted, never charged at an unapproved amount.
- **Changing the plan before paying (C3)** — `POST /api/v1/admin/billing/initial-plan`
  (billing.manage): only offered plans and prices, exactly as shown; an open
  Checkout is ended at the provider first; one that already completed refuses
  the change; compare-and-set; recorded as `PLAN_CHANGED` (source `OWNER`).
- **Activation** — plan modules, add-ons and customer sales unlock only when
  the provider has verifiably started the trial (a card-required trial only
  starts after the card is authorized) or recorded a paid period. A browser
  redirect, an opened Checkout, a saved card alone or an unpaid first invoice
  unlock nothing. A completed Checkout whose subscription does not bill
  exactly the chosen price is refused (`PRICE_MISMATCH` review case).
- **No payable Checkout left behind** — a hosted Checkout is ended before
  anything is returned if, once it exists, the selection changed or its price
  was archived; an unrecorded one is ended too; archiving a price ends the
  open Checkouts at it. An expiry whose outcome is uncertain is never treated
  as a cancellation: a `CHECKOUT_NOT_ENDED` review case is opened.
- **C2** — no separate deadline: with enforcement off a pending business keeps
  core only, no add-ons and no sales indefinitely; the existing payment setup
  deadline applies only when enforcement is on.

## SC4d — the first location and getting started

After payment setup (or while it is pending) the owner sets up the business
from **Getting started** (`/admin/getting-started`, also summarised on the
Overview page). The checklist is computed from real data on every request —
there is no progress table: business created; subscription or trial
authorized (the SC4b/SC4c test); first location; address, time zone and
phone; opening hours; a menu with at least one product a customer could buy
(active, shown, available at the location and priced above zero); online
ordering on. **"Setup complete" is not "publicly live"**: it publishes
nothing, and the business storefront (SC4f) and the other launch
requirements are separate.

| Route | Permission | |
|---|---|---|
| `POST /api/v1/admin/locations` | `locations.create` (C) | the first location; 409 `LOCATION_LIMIT_REACHED` afterwards |
| `PUT /api/v1/admin/locations/:id/profile` | `locations.edit` (C) | name, address, ISO country, IANA time zone, phone |
| `PUT /api/v1/admin/locations/:id/hours` | `locations.edit` (C) | the whole week; needs the time zone first |
| `POST /api/v1/admin/catalog/menus` | `catalog.menu.manage` (C) | idempotent by name (case-insensitive) |
| `PUT /api/v1/admin/catalog/locations/:id/menu` | `catalog.menu.manage` (C) | the location's single active menu; idempotent |
| `GET /api/v1/admin/getting-started` | `locations.view` (C) | the checklist |

- **First location only, race-safe.** Creation locks the business row, so
  concurrent or repeated submissions create exactly one location. The limit
  (`SELF_SERVICE_LOCATION_LIMIT`) is a service policy, not a data-model or API
  restriction: multi-location businesses need no schema change.
  Operator-provisioned and seeded locations are untouched.
- **`locations.create`** is new: the built-in administrator (owner) role of
  every business receives it (migration backfill; new businesses at
  provisioning). Store managers never hold it.
- **Online ordering stays OFF** for a new location, set explicitly whatever
  the column default. For a self-service business, turning it **on** is
  refused (409 `LOCATION_ORDERING_NOT_READY`, listing the missing steps) until
  billing is authorized and the location has its profile, opening hours and a
  sellable menu. Turning it off is always allowed. Operator-provisioned
  businesses keep the existing behaviour. Customer checkout keeps its own
  billing and sales checks regardless — no setup action bypasses them.
- **Opening hours** are saved and shown only. ISO weekdays, minutes after
  local midnight, closing 24:00 allowed, a closing time earlier than the
  opening time runs into the next day; overlaps — across midnight and from
  Sunday night into Monday — are refused by the shared rule (contracts) and
  the API. Future ordering-hours enforcement must handle time zones and
  daylight-saving transitions.
- **Tenant isolation.** Every write takes the business from the
  authenticated request; another business's location or menu reads as
  missing (location-scoped checks refuse it up front with 403). Opening
  periods carry a composite `(tenantId, locationId)` foreign key and the
  standard tenant-reassignment guard. The Admin location-menu read and the
  two override deletions now also filter by business in the service
  (defence in depth; they were already refused by the authorization context).
- **Audit:** `location.created`, `location.profile_updated`,
  `location.opening_hours_updated`, `catalog.menu_created`,
  `location.menu_assigned`.
- **Not in SC4d:** modifier management — a **first-launch requirement**
  (restaurants need customizable products); ordering-hours enforcement; more
  than one location; the business storefront (SC4f).

## SC4e — onboarding oversight in the Platform Console

Operators see owner registrations and the setup progress of self-service
businesses, and can pause NEW registrations in an emergency
(`/platform/onboarding`). Platform routes only: business staff and customers
never reach them.

| Route | Permission | |
|---|---|---|
| `GET /api/v1/platform/onboarding/registrations` | `onboarding.view` | registrations, newest first; filters for status, issue and dates; each view audited |
| `GET /api/v1/platform/onboarding/businesses` | `onboarding.view` | each self-service business's getting-started steps; filters; stuck after N days (default 7) |
| `GET /api/v1/platform/onboarding/registration-control` | `onboarding.view` | availability, pause history, rolling 24-hour quota, issue counts |
| `POST /api/v1/platform/onboarding/registration-control` | `onboarding.manage` | pause / resume new registrations: recent sign-in, a reason, audited |

- **Permissions.** `onboarding.view` and `onboarding.manage` are granted only
  through the existing audited grant flows (the provisioning CLI or the
  console's permission management; never to oneself); nobody receives them
  automatically. Every route re-reads the operator's grants and audits a
  refusal.
- **What is never shown.** Verification codes, passwords, the server-only
  initial-password nonce, login identifiers (identity provider subject) and
  tokens. An unverified email is masked (`j***@example.com`); a verified
  one is shown to `onboarding.view` holders. Each view of the registrations
  list is a `platform.onboarding.registrations_viewed` audit event.
- **Issues** are derived from the registration records — no separate
  failure log: code expired before verification; stopped during
  verification (mailbox proven but password not set, or every attempt at
  the code used); verified without a business.
- **Progress** is the SC4d getting-started calculation itself
  (`location-readiness.ts`, now batched — a fixed handful of queries for
  any number of businesses), so the console and the business's own
  checklist can never disagree. At most the 5,000 most recent self-service
  businesses are computed per request (the response says when it was
  truncated). No progress table.
- **The pause.** Registration is available only when the deployment flag
  `SELF_SERVICE_REGISTRATION_ENABLED` is ON **and** registration is not
  paused. The flag stays the master control: the console can never turn
  registration on. While paused, every new start — and so every new code,
  including a new password-setup code — is refused with the same 503 as the
  quota (nothing reveals an email's state); completing with a code already
  sent still works, and existing businesses are unaffected. If the pause
  state cannot be read, new starts fail closed. Pause and resume are
  serialized (an advisory lock), each needs `onboarding.manage`, a sign-in
  within the last 15 minutes and a 10–500 character reason, and each writes
  an append-only `RegistrationControlChange` row and a
  `platform.registration.paused` / `resumed` audit event.
- **The quota** shown is the count the start route enforces — new
  registrations in the rolling 24 hours — never a second counter. When it is
  used up, the console shows when the next place frees up.
- **Monitoring only.** Operators cannot act as an owner, delete a
  registration or skip identity verification. Payment setup deadlines keep
  their own permission (`billing.accounts.manage`).

## Rollback

`packages/database/prisma/rollbacks/20261106090000_owner_registration.down.sql`
(manual, refuses while any registration exists).
`packages/database/prisma/rollbacks/20261107090000_self_service_provisioning.down.sql`
(manual, SC4b; refuses while any self-service business, pending subscription,
owner history or offered plan exists; run before the SC4a rollback).
`packages/database/prisma/rollbacks/20261108090000_first_location_setup.down.sql`
(manual, SC4d; refuses while any location profile detail or opening hours
exist — so in practice only before any location was created or completed
through SC4d; removes the `locations.create` grants; run before the SC4b
rollback).
`packages/database/prisma/rollbacks/20261109090000_onboarding_oversight.down.sql`
(manual, SC4e; refuses while any registration pause history or any
onboarding permission grant, active or revoked, exists; run before the SC4d
rollback).
