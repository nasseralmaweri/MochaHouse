# Tenant isolation — phase 2

Status: proposed (depends on PR #7, "enforce tenant isolation on Admin read
paths"). Not deployed. **Production migration requires explicit approval.**

Phase 1 (PR #7) scoped every Admin read/write on tables whose `tenantId`
was already `NOT NULL`. Phase 2 completes isolation for the remaining
tenant-owned data, settings and uniqueness rules, and converts their
`tenantId` columns to `NOT NULL` with a backfill that **derives** ownership
and never assumes it.

## 1. Root causes

1. **Nullable, never-written ownership.** S0D-1 added `tenantId` to 63
   tables and backfilled them to Tenant #1, but 28 tables stayed nullable
   and their write paths never set it. Rows created after 2026-09-27 in
   those tables carry `tenantId = NULL`.
2. **Unscoped queries.** Services looked rows up by id / code / key and
   listed whole tables with no tenant predicate. The Prisma tenant
   extension is report-only (`TENANT_QUERY_AUDIT=report`) and blocks
   nothing.
3. **Global uniqueness.** `Location/Category/Product/Menu.slug`,
   `Promotion.code`, `ChecklistTemplate/LoyaltyConfiguration/
   GiftCardConfiguration/CmsPage.key` and the Mocha Bean manual-adjustment
   idempotency key were unique across ALL businesses — business settings
   were therefore shared singletons, and one business's code/name blocked
   another's.
4. **Unvalidated references.** Create/update paths accepted product,
   category, location, media, promotion and bonus-promotion ids of any
   business, so a record could be linked to another business's data.

## 2. Confirmed vulnerabilities fixed here

Admin (corporate admin of business B acting on business A):

| Area | Endpoints | Before |
|---|---|---|
| Promotions & coupons | `GET/POST /admin/promotions`, `PATCH /admin/promotions/:id` | list/edit A's promotions; link A's catalog |
| Loyalty rewards | `GET/POST/PATCH /admin/loyalty/rewards…` | list/edit A's rewards |
| Bonus promotions | `GET/POST/PATCH /admin/loyalty/bonus-promotions…` | list/edit A's bonus promotions |
| Loyalty settings | `GET/PUT /admin/loyalty/settings` | read/overwrite A's (shared) earning rate |
| Gift cards | `POST /admin/gift-cards/search`, `GET /admin/gift-cards/:id`, `…/deactivate`, `…/reactivate`, `…/corrections`, `POST /admin/gift-cards` | read A's cards and ledger; deactivate/adjust A's balances |
| Gift-card settings | `GET/PUT /admin/gift-cards/configuration` | read/overwrite A's (shared) presets |
| Campaigns | `GET/POST/PATCH /admin/marketing/campaigns…`, `…/request-approval`, `…/status` | read/edit/activate A's campaigns; link A's media/promotions |
| Approvals | `GET /admin/approvals…`, `POST …/approve`, `POST …/reject` | read and decide A's approvals |
| Media | `GET/POST/PATCH /admin/media…`, `…/deactivate` | read/edit/deactivate A's assets |
| Content (CMS) | `GET/PATCH /admin/content/:key`, `POST …/publish` | edit/publish A's (shared) pages |
| Checklist templates | template configuration | one global template per key |
| Audit log | every audit write | events stored without a tenant |

Customer-facing (storefront of business B, data of business A):

| Area | Endpoint(s) | Before |
|---|---|---|
| Checkout & quotes | `POST /orders/checkout`, `…/checkout-quote`, `…/reward-eligibility` | A's automatic promotions (all-locations) applied to B's orders; A's coupon codes redeemable; A's rewards listed/redeemable; A's bonus promotions earned; quotes priced against A's location |
| Gift cards | `POST /gift-cards/balance`, gift-card tender at checkout | A's card balance visible / A's card redeemable |
| Gift-card purchase | `GET /gift-cards/purchase-options`, `POST /gift-cards/purchase-intents` | A's presets used |
| Loyalty | `GET /loyalty` (customer) | A's reward catalog listed |
| Content | `GET /content/:key` | A's published pages served |
| Earning | order commit | A's earning rate used |

## 3. Per-model inventory

`N` = `tenantId` was nullable before this change. Every model below is
business-owned; none is genuinely platform-global (the platform-global
records are `Tenant` itself and the permission catalog, which lives in
code).

| Model | Owner established from (writes) | Reads now scoped by | Uniques |
|---|---|---|---|
| InternalAuditEvent (N) | actor InternalUser (per-tenant identity) | event + actor tenant | — |
| ApprovalRequest (N) | target campaign (validated) | tenant | one PENDING per target (global, target ids are uuids) |
| MediaAsset (N) | request tenant | tenant | — |
| CmsPage (N) | request tenant | tenant | `(tenantId, key)` — was `key` |
| CustomerLoyaltyAccount (N) | its Customer | via validated Customer | `customerId` |
| MochaBeanLedgerEntry (N) | order's / request tenant, checked against the account | via validated account | `(type, orderId)`; `(tenantId, type, operationKey)` — was `(type, operationKey)` |
| LoyaltyConfiguration (N) | request / order tenant | tenant | `(tenantId, key)` — was `key` |
| LoyaltyReward (+Product/Category) (N) | request tenant; links copy it and may only reference the tenant's catalog | tenant | — |
| LoyaltyBonusPromotion (+Product/Location) (N) | request tenant; links tenant-validated | tenant | — |
| Promotion (+Product/Category/Location/CustomerUsage) (N) | request tenant; links tenant-validated | tenant | `(tenantId, code)` — was `code` |
| Order snapshots: OrderPromotionRedemption, OrderLoyaltyRewardRedemption, OrderLoyaltyBonus(+Item), OrderGiftCardRedemption (N) | the order's tenant | via validated Order | `orderId` |
| GiftCard (N) | request tenant (HQ issuance) or its GiftCardPurchase (customer purchase) | tenant | `codeHash` (kept global: one code ⇒ one card) |
| GiftCardTransaction (N) | its GiftCard (checked at redemption) | via validated card | partial: ISSUANCE per card, REDEMPTION per order, ADJUSTMENT per operationKey (kept global) |
| GiftCardConfiguration (N) | request tenant | tenant | `(tenantId, key)` — was `key` |
| Campaign (+Product) (N) | request tenant; media/promotion/bonus/product refs tenant-validated | tenant | — |
| Location / Category / Product / Menu | (already NOT NULL) | (PR #7) | `(tenantId, slug)` — was `slug` |
| ChecklistTemplate | (already NOT NULL) | `(tenantId, key)` lookup | `(tenantId, key)` — was `key` |

Kept deliberately global: `Tenant.slug` (the platform's business
directory), `GiftCard.codeHash` (a code must identify exactly one card;
lookups are tenant-filtered), `Order.orderNumber/accessToken` and
`PaymentAttempt.idempotencyKey` (random tokens), and the gift-card
`ADJUSTMENT` operation-key partial index (a random idempotency key;
scoping its lookup without scoping the index would turn a cross-tenant
collision into a silent no-op).

## 4. Migration `20261010120000_tenant_isolation_phase_2`

One atomic unit. Order of operations:

1. **Report baseline**: count `tenantId IS NULL` per table.
2. **Direct derivations** from a single required parent whose tenant is
   authoritative: audit event ← actor; approval ← requester; media ←
   uploader; loyalty account ← customer; ledger ← account; order snapshots ←
   order; bonus item ← bonus; usage ← customer; link rows ← product /
   category / location.
3. **Evidence-derived roots** (iterated up to 3 passes for
   campaign ↔ promotion links). Each root collects every piece of evidence
   (its own tenant if set, link rows, redemptions, purchases, transactions,
   linked campaigns/images, approval requests, its audit events); it is
   filled only if all evidence names exactly one tenant.
4. Gift-card transactions inherit their (now resolved) card.
5. **Checks**: conflicting evidence, rows still NULL, and 31 parent/child
   agreement checks (e.g. ledger vs account vs order vs actor; gift card vs
   purchase; transaction vs card / order / purchase / actor; link rows vs
   both ends; campaign vs image / promotion / bonus; approval vs requester
   and decider; audit vs actor).
6. Any problem ⇒ `RAISE EXCEPTION` with a per-table report and the first
   50 offending ids per table and kind; **nothing is changed**.
7. Otherwise `SET NOT NULL` on 28 columns and swap 10 unique indexes.

Nothing is ever assigned to Tenant #1 (or any tenant) for lack of
evidence, and the migration does not depend on how many tenants exist.

### Dry run

`packages/database/prisma/scripts/tenant-isolation-phase-2-dry-run.sql`
runs the exact migration inside a transaction with
`centerivo.tenant_backfill_dry_run = 'on'`: it prints the report and then
aborts deliberately. Run it against a **restored copy** of production:

```
psql "$RESTORED_COPY_URL" -v ON_ERROR_STOP=1 \
  -f packages/database/prisma/scripts/tenant-isolation-phase-2-dry-run.sql
```

`DRY RUN complete: 0 problem row(s)` ⇒ the migration will succeed on that
data. Otherwise the listed rows need an explicit ownership decision first.

### Rows the migration cannot place (approval required)

Expected categories, if any exist in production (the dry run tells):

* a FIXED_AMOUNT reward never redeemed and with no audit history;
* a promotion with no eligibility links, usage, redemptions, campaign or
  audit history;
* a gift card with no purchase, transaction or audit event;
* a CMS page or configuration row with no audit history.

Every Admin create path has written an audit event in the same
transaction since those features shipped, so such rows should only exist
if created outside the API (manual SQL, seeds, imports). **Do not resolve
them by assuming Tenant #1** — decide each explicitly, record the decision,
apply it with a reviewed SQL statement on the restored copy, re-run the
dry run, and only then schedule the migration.

### Preconditions and procedure (production — requires approval)

1. PR #7 merged and deployed; this PR approved.
2. Fresh **full backup** (point-in-time recovery enabled) taken
   immediately before; restore it to a staging copy.
3. Dry run on the staging copy ⇒ 0 problem rows (resolve any per above).
4. Run the full migration on the staging copy; run the verification
   queries below; smoke-test the Admin and storefront.
5. Maintenance window: deploy the API build from this PR together with
   `prisma migrate deploy` (the new code requires the new unique keys and
   NOT NULL columns; the old code would write NULL tenantIds and use the
   old global keys).

### Verification after migrate

```sql
-- no nullable tenant column remains
SELECT table_name FROM information_schema.columns
 WHERE column_name = 'tenantId' AND is_nullable = 'YES';
-- per-tenant uniques exist
SELECT indexname FROM pg_indexes
 WHERE indexname ~ '_tenantId_(slug|key|code|type_operationKey)_key$';
-- financial totals unchanged (compare with the pre-migration snapshot)
SELECT sum("balanceMinorUnits") FROM "GiftCard";
SELECT sum(balance) FROM "CustomerLoyaltyAccount";
SELECT sum(amount) FROM "MochaBeanLedgerEntry";
SELECT sum("amountMinorUnits") FROM "GiftCardTransaction";
```

### Failure and rollback

* A failed check aborts the whole migration; Prisma records it as failed.
  Nothing in the data changed. Fix the cause on a copy, then
  `prisma migrate resolve --rolled-back 20261010120000_tenant_isolation_phase_2`
  and re-deploy.
* After a successful migration, a code rollback to the pre-phase-2 API is
  **not** safe (it would write NULL tenantIds into NOT NULL columns and use
  removed global keys). Roll forward, or restore the pre-migration backup
  together with the previous API build.
* The schema can be reverted manually (drop the 10 per-tenant unique
  indexes, recreate the global ones, `DROP NOT NULL`) only while no
  business has created a duplicate slug/key/code.

## 5. Tested

* Disposable copies of the migration history with fictional legacy data:
  * fully derivable, two businesses, every table — all rows assigned to the
    correct business; gift-card balances, loyalty balances, ledger and
    transaction totals identical before/after; 0 nullable columns; 10 new
    unique indexes;
  * ambiguous / conflicting / mismatched rows — migration aborts, data and
    schema unchanged, report lists each row with its evidence;
  * a copy of the representative development database — dry run 0
    problems, migration and re-seed apply cleanly.
* `apps/api/src/tenancy/tenant-isolation-phase-2.spec.ts` (14 HTTP-level
  integration tests, real guards): two businesses with identical slugs and
  coupon codes, separate staff, customers, catalog and financial records.
  Covers per-business uniqueness, NOT NULL enforcement, promotions/coupons,
  storefront checkout quotes (coupon, automatic promotion, foreign
  location, gift card), rewards, bonus promotions, loyalty and gift-card
  settings, per-business loyalty idempotency keys, gift-card search /
  detail / status / correction with balance-and-ledger integrity,
  campaigns, approvals, media, CMS drafts, audit attribution, a user of
  two businesses, forged/malformed business headers and LOCATION-scoped
  grants.
* Mutation check: 19 targeted regressions (each removing one tenant filter,
  or stamping audit events with Tenant #1) were injected one at a time;
  every one makes the spec fail.

## 6. Remaining risks / follow-ups

* Database-level enforcement of parent/child agreement (composite foreign
  keys `(tenantId, id)`) is not added; agreement is enforced in the
  application and verified by the migration. Recommended as S0D-4.
* The Prisma tenant query audit stays report-only; switching it to enforce
  mode is a separate, larger change.
* `OutboxEvent` / notification pipeline already NOT NULL (S0D-2C-2); not
  changed here.
* `GiftCardTransaction.operationKey` for ADJUSTMENT keeps its global
  partial unique index (caller-generated idempotency keys). A business that
  reuses another business's key gets a 409 for its own card; nothing of the
  other business is returned. Make it per-business if keys ever become
  predictable.
* Production may hold rows the migration cannot place; it then aborts and
  the dry-run report lists them for an explicit ownership decision.
* Storefront tenant resolution is still `SINGLE_TENANT_ID`; serving a
  second business's storefront needs host-based tenant resolution (out of
  scope).
