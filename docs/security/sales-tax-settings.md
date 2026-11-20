# Sales tax settings (V1 Sales Tax PR 1)

Built-in, per-location sales tax rules that a business's authorized
administrator configures and confirms. **This change is configuration only.**
Nothing here changes an order total, a payment, a refund or a report, and
checkout is not blocked: tax calculation and enforcement arrive in PR 2.

## What a business configures

| Piece | Where it lives | Notes |
| --- | --- | --- |
| Tax classes | `TaxClass` | Business-level groups ("Prepared Food", "Grocery", ...). Every business gets a default **Prepared Food** class (`systemKey = PREPARED_FOOD`), created on first use. Names are unique per business, ignoring case. |
| Category class | `Category.taxClassId`, `Category.taxClassReviewedAt` | Null class = the default (Prepared Food). Existing categories start **unreviewed**; the administrator must explicitly confirm each active category's class. |
| Product override | `Product.taxClassId` | Optional; null = use the category's class. |
| Location tax version | `LocationTaxVersion` | `DRAFT` → `CONFIRMED` → `SUPERSEDED`. At most one draft and one confirmed version per location (partial unique indexes). Every version is kept. |
| Tax components | `LocationTaxComponent`, `LocationTaxComponentClass` | Each tax (state, county, city, special district) with an exact integer rate in parts per million (6.25% = 62500) and the classes it applies to. A class no component applies to is not taxed at that location. |

V1 limits, enforced by the database: `source = 'BUILT_IN'` only (a future tax
provider is a new value), `pricesIncludeTax = false` only (menu prices exclude
tax), rates 0.0001%–25%, at most 10 taxes per version (API).

## Who can change it

* New permission **`tax.manage`** — corporate-only, in the core module.
* Granted only to the built-in administrator role (seed, provisioning, and a
  migration backfill for existing businesses). **Store Managers never hold
  it.**
* Every route also requires the caller to hold the business's built-in
  administrator role at corporate scope, read from the database (the same
  owner check as Payments). A custom role that holds `tax.manage` is refused
  with `TAX_SETTINGS_OWNER_ONLY`.

## Tenant isolation

* The business always comes from the request's tenant context; every id in a
  path or body is looked up inside that business, so another business's id is
  "not found" (or "choose a class from this list").
* Every link is a composite `(tenantId, id)` foreign key, so the database
  refuses a cross-business link regardless of the application.
* All four tables are registered in the tenancy inventories (model tenancy,
  relationship inventory, tenant-required models) and carry the tenant
  immutability trigger.

## Versioning and confirmation

* Saving edits the location's single draft (creating version *n + 1* when
  there is none). The confirmed version is never edited.
* Database guards: a non-draft version cannot change (except
  CONFIRMED → SUPERSEDED) or be deleted; taxes can be added or removed only
  while their version is a draft and are never updated in place.
* Confirming requires: every active category reviewed
  (`TAX_CATEGORIES_UNREVIEWED`), and the exact draft the administrator
  reviewed (`draftId` + `draftUpdatedAt`, otherwise `TAX_DRAFT_CHANGED`).
  The previous confirmed version becomes `SUPERSEDED` with its rates intact.
* Every change is audited (`tax.*` actions) with the exact ppm rates.

## Exact arithmetic

Rates are typed as a percentage string and parsed digit by digit
(`parseTaxRatePercent` in contracts): at most 4 decimal places, no exponents,
signs or numbers. Stored and summed as integers; formatted back exactly
(`formatTaxRatePpm`). No floating-point arithmetic touches a rate.

## Setup readiness

`GET /api/v1/admin/getting-started` includes `salesTax: { totalLocations,
confirmedLocations }`. It is informational only: not a step, not counted in
`setupComplete`, and `missingForOrdering` is unchanged, so online ordering and
checkout are never blocked by it in PR 1.

## Rollback

`packages/database/prisma/rollbacks/20261202090000_tax_settings.down.sql`
(never automatic). It refuses while any confirmed version exists.

## Later PRs (not in this change)

PR 2: tax calculation at checkout, order-level and line-level tax snapshots
that reconcile exactly, store-funded vs third-party-funded discounts, and
enforcement of confirmed settings. PR 3: item refunds that preserve the
original tax amounts (no automatic proportional reversal for arbitrary
monetary refunds) and tax reporting. Historical orders stay unchanged.
