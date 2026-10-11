# CI and required checks (Security 4B)

`.github/workflows/ci.yml` runs on every pull request, on pushes to `main`
and on demand. It needs no secrets: every job uses disposable PostgreSQL 16
and Redis 7 service containers and the fictional, clearly non-secret values
in the workflow's `env` block. The workflow token is read-only
(`permissions: contents: read`).

## Jobs

| Job (check name) | What it proves |
|---|---|
| **Typecheck, lint and build** | API, worker and web typecheck; API, worker and web build; on pull requests, `scripts/ci/lint-changed.mjs` fails if any changed file gains an ESLint/Prettier finding compared with the merge base |
| **API tests** | Every API suite except the tenancy and route-inventory suites, against a freshly migrated and seeded database |
| **Tenant isolation and route inventory** | The read-only tenant relationship integrity check on the seeded database, the route inventory (every registered API route classified), every `src/tenancy/` suite (including the disposable-database guard, relationship inventory and integrity checker suites) — three-business isolation, checkout financial isolation, storefront isolation, read isolation, phase 2/3/4A suites and the phase 2 migration regression tests — and the worker's tenancy suites |
| **Worker tests** | Every worker suite against a freshly migrated and seeded database |
| **Web tests** | Every web (Jest) suite |

Shared setup (`.github/actions/setup`): Node 22, the repository's pinned
pnpm (`devEngines` → 11.21.0), `pnpm install --frozen-lockfile`, Prisma
client generation, and the workspace packages built in dependency order
(contracts → database → domain, integrations, validation, ui → testing).

## Make these checks required

Branch protection is **not** changed automatically. Once the workflow has
run green on a pull request, a repository admin should require, for
`main` (Settings → Rules → Rulesets, or Branches → Branch protection):

1. `Typecheck, lint and build`
2. `API tests`
3. `Tenant isolation and route inventory`
4. `Worker tests`
5. `Web tests`

Also recommended in the same rule: require a pull request before merging,
require branches to be up to date before merging, and block force pushes
and deletions of `main`.

## Adding an API route

`apps/api/src/route-inventory/route-inventory.spec.ts` builds the real
`AppModule` and fails when a registered route is not listed in
`route-inventory.ts` (or a listed route no longer exists). Classify the new
route by the boundary its runtime authorization actually enforces —
`tenant`, `location`, `token`, `public-auth`, `platform` or `system`. Admin
routes must also carry `InternalAuthGuard` and `PermissionGuard`. A
classification documents intent; it never replaces the runtime checks or
the isolation tests.

## Test database safety (Security 4C-1)

API and worker test runs (Jest `globalSetup`), scratch-database helpers and
the shared tenant cleanup helpers call `assertDisposableDatabase()`
(`packages/testing/src/disposable-database.ts`). It proceeds only when ALL of
these hold — no single one is trusted alone:

1. **Declared test run:** `NODE_ENV=test`, `CENTERIVO_TEST_DATABASE=1`, a
   well-formed `CENTERIVO_TEST_DB_TOKEN`, and no `CENTERIVO_ENV` / `APP_ENV` /
   `DEPLOYMENT_ENV` / `ENVIRONMENT` declaring production, staging or live.
2. **Unambiguous connection:** one PostgreSQL host, a lower-case database name
   with a `test` or `ci` segment (or a `mh_scratch_` scratch name), no
   connection `options` or `PGOPTIONS`, no second database URL naming another
   database.
3. **Disposable marker:** the database's own catalog settings
   (`pg_db_role_setting`, database-wide entries only) carry
   `centerivo.disposable_database` equal to its name and
   `centerivo.disposable_token` equal to the run's token. Role-level settings
   and connection options cannot fake it, and `CREATE DATABASE … TEMPLATE`
   copies do not inherit it. Only `createDisposableDatabase` writes the
   marker, and only onto a database it has just created — an existing
   database is never marked.

   **The marker alone does not make a database safe to use.**
   `pg_dump --create` preserves database-level settings, so restoring such a
   dump recreates the marker (under the original database name); any
   database owner can also set it deliberately; and it says nothing about
   the data inside the database. It is therefore only one of four
   independent checks, and the guard refuses unless all four hold.
4. **Fictional businesses only:** every Tenant is Mocha House (Tenant #1 under
   its own slug) or a visibly-test `…7e57…` business; ambiguous identities
   and more than 25 businesses are refused.

Scratch databases may be created only next to a proven-disposable database,
and dropped only by the process that created them, only with the scratch
prefix and only while they still carry the run's marker. Cleanup helpers
delete only test-only businesses (never Tenant #1). Refusals name the failed
check and never include the connection string, user, password or host.

CI creates and marks a fresh `mocha_ci` in every database job
(`pnpm --filter @mocha-house/testing db:create-disposable`); the service
container starts with only the maintenance database.

## Tenant relationship integrity (Security 4C-1)

`packages/database/src/integrity/relationship-inventory.ts` classifies all
105 references between business-owned records (85 composite foreign-key
candidates — 84 existing foreign keys, 26 of them tenant-enforced since
Security 4C-3 / 4C-4, and 1 plain column — 8 historical
snapshots, 5 polymorphic references, 6 JSON columns, 1 external id).
`tenant-relationship-inventory.spec.ts` fails when the schema gains, loses or
changes one without a classification.

`pnpm --filter @mocha-house/database integrity:check` reports, read-only,
references that point at another business, at nothing, or contradict their
type. It runs in a `READ ONLY` transaction (SELECT privileges suffice),
never repairs anything, prints counts by relationship type and primary keys
only, and never the connection string. CI runs it on every freshly seeded
database in the tenant isolation job.

Severity rules:

- A reference that resolves to **another business** is always a violation —
  for live and historical rows alike.
- A **missing** target is a violation for live references; it is a warning
  only for history (snapshots, audit entries, processed / sent / failed
  events). A row still being acted on — a `PENDING` outbox event or
  notification delivery — with a missing target is a violation.
- A polymorphic **type the inventory cannot resolve** is a violation and is
  listed under **Not checkable** with its row count: its target is unknown,
  so a cross-business link cannot be ruled out. Audit entries whose target
  is not a record id are verified too — configuration audits must name
  `company`, notification-recipient audits must name a purpose of the same
  business.

The report's **verdict** is `CLEAN` only with zero violations and zero rows
that could not be evaluated (`INCOMPLETE` otherwise, `VIOLATIONS` when any
violation exists). By-design exclusions (snapshot JSON, external ids) are
listed under Not checkable without a row count. Exit codes: 0 clean,
1 violations, 3 incomplete, 2 the check could not run.

## Composite tenant keys (Security 4C-2)

Every table another business-owned table references — the 25 targets of
the composite foreign-key candidates in the relationship inventory — has a
`UNIQUE ("tenantId", "id")` index (`@@unique([tenantId, id])`, migration
`20261011090000_tenant_composite_keys`). Composite foreign keys
`FOREIGN KEY ("tenantId", col) REFERENCES parent ("tenantId", "id")` build
on them (Security 4C-3 onwards).

- `tenant-composite-keys.spec.ts` fails if the schema, the migration or the
  migrated test database loses (or gains) a key; proves on a scratch
  database that the migration changes nothing else; and runs the migration
  with **real `prisma migrate deploy`** (success, late failure, retry,
  recovery, lock timeout, rollback).
- The tenant isolation job also checks that `schema.prisma` is valid and
  identical to the migrated database (`prisma migrate diff --exit-code`).

### How Prisma executes a migration (verified, Prisma 7.x on PostgreSQL)

- A migration file containing **dollar-quoting** (`$`, e.g. a `DO` block) is
  sent as **one** statement — one implicit transaction: any failure rolls
  the whole file back.
- **Any other file is split into separate statements, each committed on its
  own**; a failure leaves the earlier statements applied.
- Either way a failure is recorded (`P3018`) and later deploys refuse to run
  (`P3009`) until it is resolved — it never silently counts as applied.

Migrations that must be all-or-nothing are therefore written as one `DO`
block (as 4C-2's is). `packages/testing`'s `applyMigrationSql` reproduces
this behaviour for scratch-database tests.

### If the 4C-2 migration fails

It is atomic, so nothing was created. Remove the cause (or wait for a
quieter moment — it fails after a 5-second `lock_timeout` rather than queue
application writes), then:

```bash
pnpm --filter @mocha-house/database exec prisma migrate resolve --rolled-back 20261011090000_tenant_composite_keys
pnpm --filter @mocha-house/database exec prisma migrate deploy
```

Never repair a failed migration automatically; resolve it deliberately per
environment.

### Rolling back 4C-2

Never automatic. `prisma/rollbacks/20261011090000_tenant_composite_keys.down.sql`
(one `DO` block) drops exactly these indexes: remove the `@@unique` lines and
ship that SQL as a new forward migration — only after rolling back every
composite foreign key that depends on the indexes (4C-3 first). Tested end
to end with real Prisma.

## Tenant-enforced foreign keys: customers, orders, payments (Security 4C-3)

Migration `20261012090000_tenant_fk_customer_order_payment` makes
PostgreSQL itself refuse a customer, order or payment row that references
another business's record. Nine relationships use a composite foreign key
`("tenantId", col) -> parent ("tenantId", "id")`:

| Relationship | Parent | On delete |
| --- | --- | --- |
| `CustomerPreferredLocation.customerId` | Customer | CASCADE |
| `CustomerPreferredLocation.locationId` | Location | CASCADE |
| `CustomerNote.customerId` | Customer | CASCADE |
| `Order.locationId` | Location | RESTRICT |
| `Order.customerId` (optional) | Customer | SET NULL (`customerId` only) |
| `Order.paymentAttemptId` | PaymentAttempt | RESTRICT |
| `OrderLine.orderId` | Order | RESTRICT |
| `OrderStatusHistory.orderId` | Order | RESTRICT |
| `PaymentAttempt.locationId` (optional, new) | Location | RESTRICT |

- Delete behaviour is unchanged, except that the previously unconstrained
  `PaymentAttempt.locationId` now prevents deleting a location a payment
  attempt references. **Intended behaviour (approved):** payment history is
  financial audit data, so a location with payment history is never
  hard-deleted — it is deactivated (`isActive = false`). Any future
  retention or business-offboarding process must handle payment records
  explicitly first. No application path deletes locations.
  `Order.customerId` keeps `SET NULL` for that column only
  (`ON DELETE SET NULL ("customerId")`, **PostgreSQL 15+**; the migration
  refuses to run on older servers).
- `ON UPDATE RESTRICT` (was `CASCADE`): ids never change.
- A composite key cannot stop a row from moving to another business
  together with its reference — which is exactly what a Prisma nested
  `connect` to another business's record does (Prisma writes `tenantId` with
  the reference). The six referencing tables and the `Customer` and
  `Location` parents therefore reject any change of `tenantId` on an
  existing row (trigger `<Table>_tenantId_immutable`, SQLSTATE `23001`),
  whether or not anything references the row — by SQL `UPDATE`, `MERGE`,
  `INSERT … ON CONFLICT DO UPDATE`, or any Prisma update, upsert,
  `updateMany` or nested connect / set / connectOrCreate.
- Prisma: nested creates under an `Order` take `tenantId` from the order (do
  not pass it). Clear an optional composite reference by setting the column
  to `null` (`customerId: null`), never with a relation `disconnect`, which
  would null `tenantId` too and is refused.
- `tenant-fk-customer-order-payment.spec.ts` proves, with three fictional
  businesses: same-business references accepted; every cross-business
  reference (each relationship x each ordered business pair, direct SQL
  INSERT and UPDATE, moving either side, Prisma nested connects) rejected;
  optional NULLs allowed; delete outcomes identical to a pre-4C-3 database;
  rejected writes change nothing; the integrity checker reports `CLEAN`; a
  removed key or trigger is detected; and, with real `prisma migrate
  deploy`: success with no drift, preflight abort, late failure, lock
  timeout, recovery and rollback.

### If the 4C-3 migration fails

It is one `DO` block: nothing was changed. Before changing anything it
counts, per relationship, rows whose reference points at another business
or at nothing, and aborts listing them. **It never reassigns ownership.**
Investigate each reported row with `integrity:check`, correct it
deliberately, then:

```bash
pnpm --filter @mocha-house/database exec prisma migrate resolve --rolled-back 20261012090000_tenant_fk_customer_order_payment
pnpm --filter @mocha-house/database exec prisma migrate deploy
```

It takes a 5-second `lock_timeout`: dropping and adding foreign keys locks
the child and parent tables until commit, so run it at a quiet moment.

### Rolling back 4C-3

Never automatic. Revert the composite relations in `schema.prisma` and ship
`prisma/rollbacks/20261012090000_tenant_fk_customer_order_payment.down.sql`
(one `DO` block) as a new forward migration. It restores the eight original
single-column foreign keys exactly and removes the nine composite keys, the
`Order ("tenantId", "paymentAttemptId")` key and the eight triggers; data is
untouched. Roll back 4C-4 first: its triggers use 4C-3's
`reject_tenant_reassignment()` function, so a 4C-3 rollback is refused (and
changes nothing) while 4C-4 is applied. Tested end to end with real Prisma
(catalog identical to a pre-4C-3 database).

## Tenant-enforced loyalty, gift cards and promotions (Security 4C-4)

Migration `20261013090000_tenant_fk_loyalty_giftcard_promotion` extends the
4C-3 protections to the loyalty, gift-card and promotion records. Seventeen
relationships use a composite foreign key
`("tenantId", col) -> parent ("tenantId", "id")`:

| Relationship | Parent | On delete |
| --- | --- | --- |
| `CustomerLoyaltyAccount.customerId` | Customer | CASCADE |
| `MochaBeanLedgerEntry.loyaltyAccountId` | CustomerLoyaltyAccount | CASCADE |
| `MochaBeanLedgerEntry.orderId` (optional) | Order | SET NULL (`orderId` only) |
| `OrderLoyaltyRewardRedemption.orderId` | Order | RESTRICT |
| `OrderLoyaltyBonus.orderId` | Order | RESTRICT |
| `OrderLoyaltyBonusItem.orderLoyaltyBonusId` | OrderLoyaltyBonus | CASCADE |
| `PromotionCustomerUsage.promotionId` | Promotion | CASCADE |
| `PromotionCustomerUsage.customerId` | Customer | CASCADE |
| `OrderPromotionRedemption.orderId` | Order | RESTRICT |
| `OrderPromotionRedemption.customerId` (optional, **new FK**) | Customer | SET NULL (`customerId` only) |
| `GiftCardTransaction.giftCardId` | GiftCard | RESTRICT |
| `GiftCardTransaction.orderId` (optional) | Order | SET NULL (`orderId` only) |
| `GiftCardTransaction.giftCardPurchaseId` (optional) | GiftCardPurchase | SET NULL (`giftCardPurchaseId` only) |
| `OrderGiftCardRedemption.orderId` | Order | RESTRICT |
| `GiftCardPurchase.paymentAttemptId` | PaymentAttempt | RESTRICT |
| `GiftCardPurchase.giftCardId` (optional) | GiftCard | RESTRICT |
| `GiftCardPurchase.customerId` (optional) | Customer | SET NULL (`customerId` only) |

- Delete behaviour is unchanged, with one intended exception: deleting a
  customer now clears `OrderPromotionRedemption.customerId` (it previously
  had no foreign key and was left pointing at nothing). The redemption
  snapshot itself is kept, like `Order.customerId`.
- **Historical snapshots** keep no foreign key (their source may later be
  deleted): the reward, bonus promotion, promotion, gift card and free-item
  / bonus product snapshots of the four redemption tables. A **new or
  changed** value must name an existing record of the **same** business
  (trigger `<Table>_<column>_same_tenant`, function
  `reject_cross_tenant_snapshot()`, SQLSTATE `23503`). A value stored while
  its source existed may stay **unchanged** after that source is deleted —
  history is kept, never rewritten.
- **Deleted-id reuse:** while a kept snapshot still names a deleted gift
  card, promotion, reward or bonus promotion, no other business can create
  (or rename a row to) that id (trigger `<Table>_id_not_reused`, function
  `reject_reused_snapshot_source()`, SQLSTATE `23505`); the same business
  can. Product snapshots get this guard with the catalog (Security 4C-6);
  until then a reused product id is reported by `integrity:check` as a
  cross-tenant violation.
- **Ownership:** fourteen tables reject any change of `tenantId` on an
  existing row (trigger `<Table>_tenantId_immutable`, SQLSTATE `23001`) —
  the ten referencing tables plus `GiftCard`, `Promotion`, `LoyaltyReward`
  and `LoyaltyBonusPromotion` — reusing 4C-3's
  `reject_tenant_reassignment()`. 4C-4 requires that function (the migration
  refuses to run without it) and never drops it.
- Prisma: nested creates under an `OrderLoyaltyBonus` or `GiftCard` take
  `tenantId` from the parent (do not pass it). Clear an optional composite
  reference by setting the column to `null`, never with a relation
  `disconnect`.
- Not included (Security 4C-6, catalog and offers): the offer-definition
  join tables' links (`LoyaltyRewardProduct/Category.rewardId`,
  `LoyaltyBonusPromotionProduct/Location.promotionId`,
  `PromotionProduct/Category/Location.promotionId`) and `Campaign`'s
  promotion links; staff actor links stay in 4C-5.
- `tenant-fk-loyalty-giftcard-promotion.spec.ts` proves, with three
  fictional businesses: same-business writes accepted; every cross-business
  reference, snapshot and move rejected by PostgreSQL (direct SQL and Prisma
  nested connect / set / disconnect / connectOrCreate, upsert, updateMany)
  with balances, points ledgers, card transactions and usage counters
  unchanged; delete and SET NULL outcomes identical to a pre-4C-4 database
  except the one above; the integrity checker `CLEAN`; every removed key or
  trigger detected; and, with real `prisma migrate deploy`: success without
  drift, preflight abort, missing-4C-3 refusal, late failure, lock timeout,
  recovery, rollback, and the refused out-of-order 4C-3 rollback.

### If the 4C-4 migration fails

It is one `DO` block: nothing was changed. Its preflight lists, per
relationship, rows pointing at another business or at nothing, and
snapshots naming another business's record; it never repairs or reassigns
anything. Correct each reported row deliberately, then:

```bash
pnpm --filter @mocha-house/database exec prisma migrate resolve --rolled-back 20261013090000_tenant_fk_loyalty_giftcard_promotion
pnpm --filter @mocha-house/database exec prisma migrate deploy
```

It takes the same 5-second `lock_timeout` as 4C-3.

### Rolling back 4C-4

Never automatic. Revert the 4C-4 relations in `schema.prisma` and ship
`prisma/rollbacks/20261013090000_tenant_fk_loyalty_giftcard_promotion.down.sql`
(one `DO` block) as a new forward migration. It removes only what 4C-4 added
(seventeen composite keys, eight indexes, fourteen ownership, seven
snapshot and four id-reuse triggers, and their two functions) and restores the sixteen
original single-column keys exactly; it keeps 4C-3's function. Roll back in
reverse order: 4C-4, then 4C-3, then 4C-2.

## Running the same checks locally

```bash
pnpm install --frozen-lockfile
# build packages in the order listed above, then create a NEW test database
# (DATABASE_URL must name a database that does not exist yet):
export NODE_ENV=test CENTERIVO_TEST_DATABASE=1 CENTERIVO_TEST_DB_TOKEN=<16+ chars>
export DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/mocha_test?schema=public
pnpm --filter @mocha-house/testing db:create-disposable
pnpm --filter @mocha-house/database exec prisma migrate deploy
pnpm --filter @mocha-house/database exec prisma db seed
pnpm --filter @mocha-house/database integrity:check
(cd apps/api && pnpm test)
(cd apps/worker && pnpm test)
(cd apps/web && pnpm test)
node scripts/ci/lint-changed.mjs origin/main
```
