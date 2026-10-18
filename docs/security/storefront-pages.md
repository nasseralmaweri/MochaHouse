# Restaurant-specific storefront pages (SC4f-3b)

Each published storefront presents its own business. This slice builds on
host routing (SC4f-1), publishing (SC4f-3a) and per-restaurant customer
profiles (SC4f-2).

## Storefront profile (J1)

`GET /api/v1/storefront/profile` returns only:

| Field | Meaning |
| --- | --- |
| `businessName` | The resolved business's own name |
| `orderingAvailable` | The business takes sales (not awaiting payment setup) **and** has an active location taking online orders |
| `loyaltyPointsLabel` | The business's name for its points (presentation only) |
| `presentation` | `legacy` for the business that keeps the original presentation (see below), otherwise `standard` |

- **Business resolution:** from the request's server-resolved TenantContext:
  the signed storefront hostname with routing on, or the deployment's single
  business with routing off. Nothing the browser sends can name a business.
- **Suspension:** a suspended business gets the existing 503 before any of
  this is read.
- **Unknown or unpublished address:** 404 `STOREFRONT_NOT_FOUND`, and the web
  app renders its 404 page.
- **Caching:** answers are `no-store` and vary by storefront. The web app
  fetches the profile once per request (React `cache`) through
  `storefrontApiFetch`, and no page built from it is prerendered.
- **When the API can't be reached:**
  - with routing off, pages keep the single business's legacy look, name no
    business and offer no ordering;
  - with routing on, no look is guessed: the page shows a neutral "temporarily
    unavailable" error.
- **Bad setting:** a malformed `LEGACY_STOREFRONT_TENANT_ID` stops the API
  from starting.

## Legacy presentation (Mocha House)

The business that keeps the original storefront appearance comes from
trusted deployment configuration, never a tenant id written in code:

- `LEGACY_STOREFRONT_TENANT_ID` names it explicitly. This is the same setting
  SC4f-3a registers Mocha House's existing addresses against.
- Without it, **only while host routing is off**, the deployment's single
  business keeps today's presentation. That is exactly the legacy behaviour.
- With routing on and no setting, no business is legacy.

The legacy business keeps:
- its published homepage (unchanged for every business);
- the code fallback homepage copy;
- its franchising content;
- its established appearance (no new header; the order pages keep their own
  cart link);
- the points name "Mocha Beans" unless it chooses another.

## Pages (J2–J4)

- **Business name everywhere:** generic storefront wording, headings,
  account pages, menu and location pages, and page titles use the resolved
  business's name. With the name missing, the wording is neutral.
- **Homepage:**
  - A business's published homepage is shown as before.
  - Without one, the legacy business gets its existing fallback.
  - Any other business gets a clean default: its name, an "Order Online" or
    "View Menu" button, and links to locations and account. No Mocha House
    copy or imagery.
- **Franchising:**
  - The legacy business keeps its established page, inquiry form and consent
    text.
  - Any other business has **no** franchising page or form (404) unless it
    published its own franchising content.
  - No franchise, legal or financial copy is generated.
  - The inquiry consent names the business the form belongs to.
- **Header:** standard storefronts get a compact header (business name, Menu,
  Account, and Cart only while the business can take orders). There is no
  theme editor, and logos are deferred.

## Loyalty points name (J5)

- **Where it's stored:** `LoyaltyConfiguration.pointsLabel`, a nullable
  column (migration `20261113090000_loyalty_points_label`, additive, bounded
  by a CHECK).
- **What is shown:**
  - the business's own name; else
  - "Mocha Beans" for the legacy business; else
  - "Points".
- **Presentation only:** balances, ledger entries, earning, redemption and
  every API amount are unchanged.
- **Where it appears:** customer pages (account, rewards, checkout,
  confirmation, order history) and the business admin's loyalty screens.
  Staff get it from `/internal/me`.
- **Editing:** Admin → Loyalty → Settings → "Points name"
  (`loyalty.configure`, corporate). Each change is audited
  (`loyalty.points_label_changed`), with the row locked so the recorded
  "before" is always right.
- **No data changes:**
  - No existing row is backfilled.
  - The seeded development Mocha House sets "Mocha Beans" explicitly.
  - Deployments keep "Mocha Beans" through the legacy rule above.
  - No tenant id is assumed.
- **Rollback:** `prisma/rollbacks/20261113090000_loyalty_points_label.down.sql`
  refuses while any business has chosen a name.
- **Unchanged audit text:** historical audit text naming "Mocha Beans" is
  left as recorded.

## Browse-only (J6)

- **Ordering offered only when both hold:** the location takes online orders,
  and the business takes orders (`orderingAvailable`).
- **What browsing shows:** every location, its menu and its products with
  accurate prices, plus a clear "Online ordering isn't available here right
  now" message. Product pages show the item and price with no add-to-cart.
- **Cart and checkout:** the cart and checkout treat the business, or the
  location, not taking orders as ordering closed; Place order is disabled.
- **Server enforcement is unchanged:** checkout, gift-card sales,
  entitlements and billing.
- **Not in this slice:** opening-hours enforcement, and any change to
  cancellation or closure.

## Carts (J7)

- **Separate storage per address:** carts live in each storefront address's
  own browser storage, so one address never sees another's cart.
- **Server check:** when a saved cart's location is not one this
  storefront's business offers, the storefront's menu route answers 404
  `LOCATION_NOT_IN_STOREFRONT` (another business's location reads like a
  missing one).
- **Clearing:** only that answer clears the cart, with a message. An outage
  or any other 404 keeps the cart. Nothing is moved or re-priced across
  businesses.
- **Checkout:** a foreign cart is cleared and the customer is returned to the
  cart page.
- **Server authority:** checkout re-prices and validates everything on the
  server. Host-only sessions and the guest and restricted-account rules from
  SC4f-2 are unchanged.

## Tests (J8)

- `apps/api/src/tenancy/storefront-profile.spec.ts`: three businesses through
  host routing, plus routing off. Covers:
  - each business's own name, ordering state and points name;
  - legacy only for the configured business;
  - no-store and vary headers;
  - unknown, unpublished, unsigned and spoofed requests;
  - menu and price isolation;
  - ordering closed;
  - suspension;
  - the legacy fallback with routing off;
  - points-name settings (normalized, bounded, audited, isolated, balances
    untouched).
- `apps/api/src/loyalty/loyalty-settings.spec.ts`: the points-name routes
  over HTTP (401, 403 for view-only, store-manager and location-scoped staff
  with no change or audit, invalid names, clearing, `/internal/me`).
- `apps/api/src/tenancy/legacy-brand.spec.ts`: the legacy rule and the
  points-name rules.
- `apps/api/src/tenancy/loyalty-points-label-migration.spec.ts`: existing
  data unchanged, the CHECK, and rollback.
- `apps/web/src/lib/storefront-pages.spec.ts`: profile fetch (404 page, the
  outage rule), wording helpers, points names, and cart binding (cleared only
  on the storefront's own answer).
- `apps/web/src/lib/storefront-context.spec.ts`: the menu route's
  `LOCATION_NOT_IN_STOREFRONT` answer.
- Browser smoke on two local hosts: see the PR description.
