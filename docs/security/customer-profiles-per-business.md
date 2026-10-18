# Customer profiles per restaurant (SC4f-2)

One CENTERIVO customer login (one identity in the shared customer user pool)
may have a **separate profile at each restaurant**. Each profile is that
restaurant's own record of the customer, with its own:

- orders and transaction history;
- loyalty balance and history;
- gift-card purchases;
- saved locations and preferences;
- marketing consent;
- account status.

Nothing is shared, linked or copied between restaurants.

## Data model

- `Customer` is one restaurant's profile of one login.
- `(tenantId, externalProvider, externalSubject)` is unique (migration
  `20261111090000_customer_profiles_per_business`). This replaces the earlier
  platform-wide `(externalProvider, externalSubject)`.
- Every child record already references its profile through
  `(tenantId, customerId)` composite foreign keys (Security 4C-3), so the
  database itself refuses a record that points at another restaurant's
  profile.
- Existing customers keep their ids, logins and data. The migration reads and
  changes no rows: it creates the new index before dropping the old one, in
  one atomic block.
- Rollback: `prisma/rollbacks/20261111090000_customer_profiles_per_business.down.sql`.
  It refuses while any login holds profiles at more than one restaurant.

## How a profile comes to exist

A profile is created **only by an explicit action at that restaurant**:

| Action | Where |
| --- | --- |
| Registering at the restaurant | `POST /auth/register` → `CustomersService.createAtRegistration` |
| Choosing to join it | `POST /customers/me/enrollment` → `CustomersService.enroll` |

`POST /customers/me/enrollment`:

- **Authentication**: a signed-in customer (`CustomerAuthGuard`) whose email
  the identity provider has verified. Otherwise the answer is
  `403 CUSTOMER_EMAIL_NOT_VERIFIED`.
- **Restaurant**: the server-resolved one. With SC4f-1 routing on, that is the
  signed storefront hostname; otherwise the deployment's business. Nothing in
  the request can name a restaurant.
- **Idempotent and concurrency-safe**: the unique key decides.
  - `201` when a profile was created; `200` with the existing profile,
    unchanged, otherwise.
  - Joining again can never lift a restriction, reset consent or change any
    data.
- **Initial contents**: the new profile starts from the login's verified
  claims (email, and name unless one is given while joining), with marketing
  consent **off**. Nothing is copied from another restaurant.
- **Rate limited**: policy `customer-enrollment` (10 per login per hour, 600
  per restaurant per hour). Browser calls arrive only through the web app's
  same-origin Server Action.

Every other customer route resolves the existing profile
(`CustomersService.requireCustomer`). A login with no profile at this
restaurant gets `403 CUSTOMER_NOT_ENROLLED`, whose body carries the resolved
restaurant's own `businessName` and nothing about any other restaurant. **No
route creates a profile on first use, borrows another restaurant's profile,
or matches by email.**

An interrupted registration (the login was created but its profile was not)
is completed by the same explicit join. No profile is ever created just
because a login has none anywhere.

### Lookups

- Email verification marks only the current restaurant's profile.
- Gift-card code recovery checks the profile in the purchase's restaurant.
- There is no remaining lookup by login or email across restaurants.

## Account status (per restaurant)

Status belongs to one restaurant's profile. It never affects the shared login
or the customer's profiles elsewhere.

| Access | ACTIVE | RESTRICTED | DEACTIVATED |
| --- | --- | --- | --- |
| Own profile (`GET /customers/me`), reading consent, withdrawing marketing consent | ✓ | ✓ | ✓ |
| History and balances: orders, loyalty, saved locations | ✓ | ✓ | — |
| Ordering, quotes, rewards, reorder, gift-card purchase and recovery, profile and saved-location changes, opting in to marketing | ✓ | — | — |

- Refusals are `403 CUSTOMER_ACCOUNT_RESTRICTED` or
  `403 CUSTOMER_ACCOUNT_UNAVAILABLE`. They say "at this restaurant" and never
  give a reason.
- A signed-in checkout **never falls back to a guest order**: a session that
  is present but cannot be verified (expired, forged) is refused with 401 by
  `OptionalCustomerAuthGuard`, and a verified one needs an ACTIVE profile.
  A fully anonymous guest order carries no login, so it is outside the
  status matrix by design.
- A profile's email follows the login's email only when the identity
  provider reports it **verified**; a deactivated profile is never written
  by a read.
- The web app's "Continue as a guest" (`POST /api/checkout?as=guest`) is
  honoured only after the API confirms `CUSTOMER_NOT_ENROLLED`. A login with
  any profile here (active, restricted or deactivated) gets
  `409 GUEST_CHECKOUT_NOT_ALLOWED`.
- No operator control sets a status yet. That control, and per-restaurant
  closure and deletion, are first-launch follow-ups.

## Sessions

- Customer session cookies stay **host-only**, so each restaurant's address
  has its own session. The same CENTERIVO credentials sign in separately at
  each restaurant.
- There is no shared cross-domain cookie and no automatic single sign-on.
- A token presented at a restaurant the login has not joined gets
  `CUSTOMER_NOT_ENROLLED`, never another restaurant's data.

## Web experience

- `/account/join` says: "Join {restaurant} with your CENTERIVO account". The
  restaurant name comes from the API.
- The customer can join, order as a guest or sign out.
- Account pages send a login that has not joined here to that page.
- At checkout, the same prompt offers to join or to continue as a guest.
- The account page explains a restricted or deactivated profile.

## Deferred (first launch)

- Per-restaurant profile closure, a shared-identity deletion policy, data
  retention and financial-record rules, and privacy rights. Deletion
  behaviour is not implemented.
- Generic CENTERIVO branding of identity-provider emails, and
  restaurant-specific customer communications (SC4f-3), before more than one
  public storefront goes live.

## Tests

- `apps/api/src/tenancy/customer-profiles-per-business.spec.ts`: end to end
  across two restaurants. Covers:
  - separate balances, consent and saved locations;
  - cross-restaurant token use;
  - no email linking;
  - restricted and deactivated profiles;
  - no guest fallback;
  - routing off.
- `apps/api/src/tenancy/tenant-customer-jit.spec.ts`: profile ownership,
  client-supplied business ignored, verified-only joining, idempotency,
  concurrent joins.
- `apps/api/src/tenancy/customer-profiles-per-business-migration.spec.ts`:
  existing data preserved, the new uniqueness rules, and rollback.
- `apps/web/src/lib/auth/customer-account-state.spec.ts` and
  `apps/web/src/app/api/checkout-guest-choice.spec.ts`.
