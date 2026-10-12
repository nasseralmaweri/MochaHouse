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
(`packages/database/src/testing/disposable-database.ts`, re-exported by
`@mocha-house/testing`). It proceeds only when ALL of
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

### Prisma commands are guarded too (Security follow-up F-1)

`prisma migrate deploy` (also `migrate dev` / `reset`, `db push`) **creates**
the database its URL names when it does not exist. A refused
`db:create-disposable` followed in the same shell by `migrate deploy` could
therefore create and migrate an unguarded database (observed in the Security
4C-5 review). The guard is now enforced by Prisma's own configuration, before
Prisma connects (`packages/database/src/testing/prisma-command-guard.ts`):

- **Where:** `packages/database/prisma.config.ts` (every Prisma CLI command of
  the repository), the configs of throwaway migration projects
  (`createMigrationProject`, used by the migration regression suites), and
  `prisma/seed.ts` when run directly.
- **When:** any Prisma command that touches a database (`migrate …`, `db …`,
  `studio`) in a run that declares itself a test in any way
  (`NODE_ENV=test`, `CENTERIVO_TEST_DATABASE` or `CENTERIVO_TEST_DB_TOKEN`
  set), or aimed at a database named like a test database (a `test` / `ci`
  segment or the scratch prefix, any case).
- **What:** the database must already exist and pass checks 1–3 above
  (declared test run, unambiguous URL, this run's marker). Otherwise the
  command stops with the guard's message and nothing is created, migrated or
  seeded — whatever ran before it in the shell. `generate`, `validate` and
  `format` never connect and are not affected.
- **Not affected:** ordinary development and real deployments — no test
  declaration and a database not named like a test database.

### Seed safety (audit DB2-1 / DB2-2)

`packages/database/prisma/seed.ts` is development and test bootstrap data
(demo locations and menu, a local-dev administrator that signs in without a
password, the built-in roles). It is **not** a production bootstrap. Before it
touches anything it calls `assertSeedSafe`
(`packages/database/src/testing/seed-guard.ts`), which fails closed:

- **Production, staging and live are refused.** `NODE_ENV` or any of
  `CENTERIVO_ENV`, `APP_ENV`, `DEPLOYMENT_ENV`, `ENVIRONMENT` set to
  `production`, `prod`, `staging` or `live` stops the seed, even against a
  database that looks like a test database.
- **Ambiguous targets are refused:** no URL, a non-PostgreSQL URL, several
  hosts, connection `options`, `PGOPTIONS`, or a `DIRECT_URL` /
  `SHADOW_DATABASE_URL` naming a different host or database.
- **Two ways to be allowed.** (1) A *verified disposable* database — a declared
  test run (or a test-named database) whose catalog marker and token pass the
  checks above. (2) A *loopback* host (`localhost`, `127.0.0.0/8`, `::1`) with
  no test declaration — the ordinary development database. Anything else, such
  as a remote host that is not a verified disposable database, is refused.
- Refusals name the failed check, never the connection string, user, password
  or host.

**A re-run never changes what HQ changed.** Everything the seed writes is
create-once: a re-run does not reactivate a suspended administrator, restore a
revoked permission (role permissions are seeded when the role is first
created), re-grant a removed role assignment, re-enable a disabled location,
delete price or availability overrides, or revert modifier prices and checklist
templates. The Size modifier lookups are tenant-scoped.

**Local-dev administrator** (`admin@mochahouse.test`, provider `internal-dev`):
created only when the row does not exist, and only in a verified disposable
database, or in a loopback database with the explicit opt-in
`SEED_DEV_ADMIN=1`. A loopback address is not proof that a database is
disposable (a tunnel or port-forward makes any database look local), so the
opt-in is deliberate.

**`SEED_RESET=1`** restores the seeded defaults (location flags, the seeded
override rows, modifier options, built-in role display fields and permissions,
the admin's status and assignment, checklist templates). It is allowed **only**
on a verified disposable database; on a local, remote, staging or production
database the seed refuses to run. A developer who relied on re-seeding to
reset a local database should use a disposable database
(`pnpm --filter @mocha-house/testing db:create-disposable`) or recreate it.

Existing databases that were seeded before this change keep their
`internal-dev` administrator row; remove it from any shared or live database
with an audited, approved query. See the regression suite
`apps/api/src/tenancy/seed-safety.spec.ts`.

**Boundary (what is not covered).** Confirmed by the independent PR #17
review:

- A Prisma run given a **different, unguarded `--config` file** bypasses the
  guard (verified: it creates and migrates the database).
- A run that **declares nothing and targets a non-test-named database** is
  not guarded — by design, that is how real environments are migrated, so
  such a run must never be pointed at a database it should not change. The
  real protection there is least-privilege credentials (T-2 below).
- **Tools other than Prisma** (`psql`, `pg_restore`, `createdb`, scripts
  using their own connection) are outside the guard.
- **`prisma migrate dev` shadow database:** `migrate dev` creates and drops
  its own temporary shadow database, outside the guard (the guard checks only
  the database `DATABASE_URL` names). `migrate dev` is a development command
  and is not used by any test workflow.

Regression tests: `apps/api/src/tenancy/prisma-command-guard.spec.ts`.

**Migration-runner compatibility (deployment prerequisite).**
`prisma.config.ts` loads the guard from TypeScript **source**
(`packages/database/src/testing/`) every time Prisma starts, including real
deployments where it returns immediately. A migration runner must therefore
ship `packages/database/src` together with `prisma/` and its
`node_modules` (`pg`); an image that ships only the compiled `dist/` cannot
load the config and every Prisma command fails. Real environments must also
never set `NODE_ENV=test` or any `CENTERIVO_TEST_*` variable: Prisma then
refuses to touch the database (fails safe, but blocks the deploy).

## Tenant relationship integrity (Security 4C-1)

`packages/database/src/integrity/relationship-inventory.ts` classifies all
105 references between business-owned records (86 composite foreign-key
candidates, all with a foreign key and — since Security 4C-7 — all 86
tenant-enforced (4C-3 … 4C-7) — 8 historical
snapshots, 4 polymorphic references, 6 JSON columns, 1 external id).
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
untouched. Roll back 4C-5 and 4C-4 first: their triggers use 4C-3's
`reject_tenant_reassignment()` function, so a 4C-3 rollback is refused (and
changes nothing) while either is applied. Tested end to end with real Prisma
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
  can. Product snapshots are **not** protected against id reuse yet — see
  the open security finding below.
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
  promotion links — enforced since 4C-6; staff actor links stay in 4C-5.
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

### SECURITY FINDING (4C-4) — RESOLVED IN CODE BY SECURITY 4C-6 (MERGED); NOT YET APPLIED TO A PERSISTENT ENVIRONMENT

*Resolved in code by Security 4C-6, merged to `main` (see "Product
snapshots (closes the 4C-4 finding)"): the reuse guard, the indexes and a
passing prevention test, confirmed by the independent 4C-6 review on fresh
disposable databases. It protects a persistent environment only once the
4C-6 migration has actually been applied there and verified — until then
no persistent environment may be described as protected. The regression
tests stay in place. A database owner or superuser can still bypass the
guard (disable triggers, drop keys); that remains open under T-2. The
original record follows unchanged.*

**Product snapshots remain vulnerable to deleted-id reuse across tenants.**
The three product-snapshot references —
`OrderLoyaltyRewardRedemption.freeItemProductId`,
`OrderLoyaltyBonusItem.productId` and
`OrderPromotionRedemption.freeItemProductId` — are validated when written
(an existing product of the same business), but once that product is
deleted another business can create a product with the same id, and the
kept snapshot then names another business's record.

- **Status:** open. Deferral to Security 4C-6 approved; this is a
  **mandatory 4C-6 deliverable**, not an optional enhancement. Product
  snapshot isolation is **not** fully enforced until it is closed.
- **Required in 4C-6:** an index on each of the three columns and the
  corresponding deleted-id reuse guard on `Product` (the same
  `reject_reused_snapshot_source()` pattern used for gift cards,
  promotions, rewards and bonus promotions).
- **Detection only, until then:** `integrity:check` reports such a row as a
  cross-tenant violation; it does not prevent it.
- **Regression test:** `tenant-fk-loyalty-giftcard-promotion.spec.ts`
  ("residual until Security 4C-6 …") demonstrates the limitation today. It
  must stay in place and be turned into a passing prevention test (the
  reuse rejected) when the guard is added — never removed.
- **Closure:** only by implementation, adversarial tests and an independent
  review. This finding must be closed before multi-tenant production
  readiness can be approved; Security 4C-4 alone does not authorize
  deployment or a second production tenant.

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
reverse order: 4C-7, then 4C-6, then 4C-5, then 4C-4, then 4C-3, then 4C-2
(PostgreSQL refuses this rollback while 4C-6 is applied).

## Tenant-enforced staff authorization (Security 4C-5)

Migration `20261014090000_tenant_fk_staff_authorization` makes PostgreSQL
enforce that staff identities, roles, role assignments and every staff-actor
reference stay inside one business. Seventeen relationships use a composite
foreign key `("tenantId", col) -> parent ("tenantId", "id")`:

| Relationship | Parent | On delete |
| --- | --- | --- |
| `InternalRolePermission.roleId` | InternalRole | CASCADE |
| `InternalUserRoleAssignment.internalUserId` | InternalUser | CASCADE |
| `InternalUserRoleAssignment.roleId` | InternalRole | RESTRICT |
| `InternalUserRoleAssignment.scopeId` (optional, **new FK**) | Location | RESTRICT |
| `InternalAuditEvent.actorInternalUserId` | InternalUser | RESTRICT |
| `ApprovalRequest.requestedByInternalUserId` | InternalUser | RESTRICT |
| `ApprovalRequest.decidedByInternalUserId` (optional) | InternalUser | RESTRICT |
| `ChecklistInstanceItem.completedByInternalUserId` (optional) | InternalUser | RESTRICT |
| `ChecklistInstanceItem.exceptionByInternalUserId` (optional) | InternalUser | RESTRICT |
| `OperationsTask.createdByInternalUserId` | InternalUser | RESTRICT |
| `OperationsTask.completedByInternalUserId` (optional) | InternalUser | RESTRICT |
| `CustomerNote.authorInternalUserId` | InternalUser | RESTRICT |
| `JobApplicationNote.authorInternalUserId` | InternalUser | RESTRICT |
| `FranchiseInquiryNote.authorInternalUserId` | InternalUser | RESTRICT |
| `MediaAsset.uploadedByInternalUserId` | InternalUser | RESTRICT |
| `MochaBeanLedgerEntry.actorInternalUserId` (optional) | InternalUser | RESTRICT |
| `GiftCardTransaction.actorInternalUserId` (optional) | InternalUser | RESTRICT |

- **Role-assignment scope.** `scopeId` was the only polymorphic staff
  reference, and its only target type is `Location` (CORPORATE carries no
  id). It keeps its name (no contract or API change) and gains its first
  foreign key: a LOCATION grant can only name a location of the same
  business. A CHECK (`InternalUserRoleAssignment_scope_shape_check`) keeps
  CORPORATE ⇔ no `scopeId` and LOCATION ⇔ a `scopeId`, the shape
  `AuthorizationService` already required. A future scope type (for example
  a location group) needs its own foreign key and this CHECK updated.
- **One CORPORATE grant per user and role.** The existing unique key treats
  NULL `scopeId`s as distinct, so two identical CORPORATE grants were
  possible (the application's Serializable check normally prevented them)
  and revoking one would have left the other in force. A partial unique
  index (`InternalUserRoleAssignment_corporate_grant_key`) now rules that
  out.
- Delete behaviour is unchanged, with one intended exception: a location
  that a LOCATION grant names can no longer be deleted out from under the
  grant (the grant used to be left pointing at nothing). The application
  never deletes locations, users or roles.
- **Ownership:** eleven more tables reject any change of `tenantId` on an
  existing row (`<Table>_tenantId_immutable`, SQLSTATE `23001`):
  `InternalUser`, `InternalRole`, `InternalRolePermission`,
  `InternalUserRoleAssignment`, `InternalAuditEvent`, `ApprovalRequest`,
  `ChecklistInstanceItem`, `OperationsTask`, `JobApplicationNote`,
  `FranchiseInquiryNote` and `MediaAsset` (`CustomerNote`,
  `MochaBeanLedgerEntry` and `GiftCardTransaction` already were). 4C-5
  requires 4C-3's `reject_tenant_reassignment()` and never drops it.
- Prisma: since the staff relations are composite, a nested create under a
  user, role or location takes `tenantId` from the parent (do not pass it),
  and including `role` on an assignment resolves only a role of the
  assignment's own business. Clear an optional staff actor by setting its
  column to `null`; a relation `disconnect` would clear `tenantId` too and
  is refused (a tripwire test lists every `disconnect` in application code).
- Not included: the operations records' own links
  (`ChecklistInstance.locationId` / `templateId`,
  `ChecklistInstanceItem.checklistInstanceId`, `OperationsTask.locationId`)
  became composite in Security 4C-7, and the catalog/offer links in
  Security 4C-6; audit and approval *targets* stay polymorphic (checked
  by the integrity checker).
- `tenant-fk-staff-authorization.spec.ts` proves, with three fictional
  businesses: same-business onboarding, role change, location grant,
  revocation and staff-actor writes accepted; every cross-business grant,
  role, permission, location, staff actor and move rejected by PostgreSQL
  (direct SQL for all seventeen relationships and six business pairs, and
  Prisma nested create / connect / set / connectOrCreate, upsert,
  updateMany); malformed scopes and duplicate CORPORATE grants rejected;
  the application's assignment, revocation, deactivation and note paths
  tenant-safe (concurrent duplicate grants yield exactly one); delete
  outcomes identical to a pre-4C-5 database except the one above; the
  integrity checker `CLEAN`; every removed key, trigger, CHECK or index
  detected; and, with real `prisma migrate deploy`: success without drift,
  preflight abort, missing-4C-3 refusal, late failure, lock timeout,
  recovery, rollback and re-apply, the refused 4C-3 rollback, and the full
  4C-5 → 4C-4 → 4C-3 rollback chain.

### If the 4C-5 migration fails

It is one `DO` block: nothing was changed. Its preflight lists, per
relationship, rows pointing at another business's (or a missing) user,
role or location, assignments whose scope shape is malformed, and user/role
pairs holding duplicate CORPORATE grants. It never repairs, merges, revokes
or reassigns anything — which grant to keep, or which business's staff
member authored a record, is a human decision. Correct each reported row
deliberately, then:

```bash
pnpm --filter @mocha-house/database exec prisma migrate resolve --rolled-back 20261014090000_tenant_fk_staff_authorization
pnpm --filter @mocha-house/database exec prisma migrate deploy
```

It takes the same 5-second `lock_timeout` as 4C-3 and 4C-4.

### Rolling back 4C-5

Never automatic. Revert the 4C-5 relations in `schema.prisma` (back to
single-column relations; remove `InternalUserRoleAssignment.location` and
`Location.staffRoleAssignments`) and ship
`prisma/rollbacks/20261014090000_tenant_fk_staff_authorization.down.sql`
(one `DO` block) as a new forward migration. It removes only what 4C-5
added (seventeen composite keys, the scope CHECK, the CORPORATE-grant index
and eleven ownership triggers) and restores the sixteen original
single-column keys exactly; it keeps 4C-3's function. Roll back in reverse
order: 4C-7, then 4C-6, then 4C-5, then 4C-4, then 4C-3, then 4C-2. (PostgreSQL itself refuses a
4C-3 rollback while 4C-5 is applied; a 4C-4 rollback shares no object with
4C-5 and is not refused, so the order is a procedure — follow it.)

## Tenant-enforced catalog, offers and product snapshots (Security 4C-6)

Migration `20261015090000_tenant_fk_catalog_offers_snapshots` makes
PostgreSQL enforce that the catalog (categories, products, modifiers,
menus, location menus, price and availability overrides), the offer
definitions (reward, bonus-promotion and promotion product / category /
location rules) and campaigns stay inside one business, and closes the
product-snapshot finding recorded in 4C-4. Thirty-three relationships use a
composite foreign key `("tenantId", col) -> parent ("tenantId", "id")`,
`ON UPDATE RESTRICT`:

| Relationships | Parent | On delete |
| --- | --- | --- |
| `Product.categoryId`, `LoyaltyRewardCategory.categoryId`, `PromotionCategory.categoryId` | Category | RESTRICT |
| `ModifierOption.modifierGroupId`, `ProductModifierGroup.modifierGroupId` | ModifierGroup | RESTRICT |
| `ProductModifierGroup.productId`, `MenuProduct.productId`, `LocationProductPriceOverride.productId`, `LocationProductAvailabilityOverride.productId`, `LoyaltyRewardProduct.productId`, `LoyaltyBonusPromotionProduct.productId`, `PromotionProduct.productId`, `CampaignProduct.productId` | Product | RESTRICT |
| `MenuProduct.menuId`, `LocationMenu.menuId`, `LocationProductPriceOverride.menuId`, `LocationProductAvailabilityOverride.menuId` | Menu | RESTRICT |
| `LocationMenu.locationId`, `LocationProductPriceOverride.locationId`, `LocationProductAvailabilityOverride.locationId`, `LoyaltyBonusPromotionLocation.locationId`, `PromotionLocation.locationId` | Location | RESTRICT |
| `LoyaltyRewardProduct.rewardId`, `LoyaltyRewardCategory.rewardId` | LoyaltyReward | CASCADE |
| `LoyaltyBonusPromotionProduct.promotionId`, `LoyaltyBonusPromotionLocation.promotionId` | LoyaltyBonusPromotion | CASCADE |
| `PromotionProduct.promotionId`, `PromotionCategory.promotionId`, `PromotionLocation.promotionId` | Promotion | CASCADE |
| `Campaign.promotionId` (optional) | Promotion | RESTRICT |
| `Campaign.loyaltyBonusPromotionId` (optional) | LoyaltyBonusPromotion | RESTRICT |
| `CampaignProduct.campaignId` | Campaign | CASCADE |
| `Campaign.mediaAssetId` (optional, **new FK**) | MediaAsset | RESTRICT |

- Delete behaviour is unchanged, with one intended exception: a media asset
  that a campaign shows can no longer be deleted (the campaign used to be
  left pointing at nothing). The application deactivates media assets and
  never deletes them. `ON UPDATE` became RESTRICT (was CASCADE): ids never
  change.
- **Ownership:** nineteen more tables reject any change of `tenantId` on an
  existing row (`<Table>_tenantId_immutable`, SQLSTATE `23001`): `Category`,
  `Product`, `ModifierGroup`, `ModifierOption`, `ProductModifierGroup`,
  `Menu`, `MenuProduct`, `LocationMenu`, `LocationProductPriceOverride`,
  `LocationProductAvailabilityOverride`, `LoyaltyRewardProduct`,
  `LoyaltyRewardCategory`, `LoyaltyBonusPromotionProduct`,
  `LoyaltyBonusPromotionLocation`, `PromotionProduct`, `PromotionCategory`,
  `PromotionLocation`, `Campaign` and `CampaignProduct`.
- **Requires** 4C-3's `reject_tenant_reassignment()` and 4C-4's
  `reject_cross_tenant_snapshot()` / `reject_reused_snapshot_source()`
  (it refuses to run without them) and drops none of them.
- Not included: `NotificationDelivery.outboxEventId`, the operations
  records' own links (checklists, tasks) and the careers / franchising
  links (10 relationships) — tenant-enforced since Security 4C-7.

### Product snapshots (closes the 4C-4 finding)

Four columns keep the id of the product an order line, free item or bonus
item was about: `OrderLine.productId`, `OrderLoyaltyBonusItem.productId`,
`OrderLoyaltyRewardRedemption.freeItemProductId` and
`OrderPromotionRedemption.freeItemProductId`. They are history, so they
have no foreign key (a product may be deleted; the snapshot stays). Now:

1. **A new or changed snapshot must name an existing product of the same
   business** (SQLSTATE `23503`). The three 4C-4 snapshots already were;
   `OrderLine.productId` was not checked at all and now is
   (`OrderLine_productId_same_tenant`). An unchanged value may outlive its
   product.
2. **A deleted product's id can never be taken by another business** while a
   snapshot of the original business names it: `Product_id_not_reused`
   refuses the insert or id change (SQLSTATE `23505`). The original
   business may re-create it. One trigger checks all four columns (4C-4's
   `reject_reused_snapshot_source()` now takes several table / column
   pairs); each column is indexed so the check is an index lookup.
3. **Race closed.** 4C-4's validation read the product without a lock, so a
   product could be deleted, and its id re-created by another business,
   between the snapshot's validation and its commit. The validation now
   locks the product row (`FOR KEY SHARE`) until the writing transaction
   ends: a concurrent delete waits (or times out) instead. This applies to
   all eight snapshot triggers (4C-4's seven and the new one). `FOR KEY
   SHARE` conflicts with a delete and with any *key* update: a change to
   the id or to any other column in a unique index. Edits of price, name,
   availability or category do not wait; a change of a product's `slug`
   (unique per business, `Product_tenantId_slug_key`) — and any other
   unique-index key update on a snapshot source — **does** wait until open
   snapshot-writing transactions on that row end (or fails on its own
   `lock_timeout`). The application does not change slugs today.

The 4C-4 regression test ("residual until Security 4C-6 …") is now a
prevention test: the reuse is rejected, and the integrity checker reports
no violation (only the kept snapshot's missing product, as a history
warning).

### Application changes

- Nested creates under a reward, bonus promotion, promotion or campaign no
  longer pass `tenantId` (Prisma takes it from the parent of a composite
  relation and refuses the argument). Three admin services and their tests
  were updated; the create endpoints for rewards, bonus promotions and
  promotions would otherwise fail.
- Campaign editing clears and sets its promotion links through the scalar
  columns (`promotionId: null`) instead of `connect` / `disconnect`: a
  relation `disconnect` on a composite relation would also clear `tenantId`
  and is refused. The tripwire test now lists one remaining `disconnect`
  (`JobOpening.location`, not tenant-enforced yet).

### Tests

`tenant-fk-catalog-offers.spec.ts` proves, with three fictional businesses:
same-business writes accepted for all 33 relationships; every cross-business
reference rejected on the exact constraint (direct SQL, six business pairs,
insert and update) and every move rejected by the ownership triggers;
32 Prisma shapes × 6 pairs (nested create / connect / set, upsert,
updateMany, moves) rejected with prices, menus, overrides and snapshots
unchanged; the application's catalog, offer and campaign workflows; the
snapshot rules (cross, missing, kept after delete, reuse by INSERT and id
UPDATE per snapshot, same-business re-creation) and the three-session race
— which **reproduces** the cross-business snapshot with the 4C-4 function
and is closed with the new one; delete outcomes identical to a pre-4C-6
database except the media asset above; the integrity checker `CLEAN`;
every removed key, trigger or snapshot guard detected; and, with real
`prisma migrate deploy`: success without drift, preflight abort with
counts and recovery, refusal without the 4C-3 or 4C-4 functions, late
failure, lock timeout, rollback and re-apply, the refused out-of-order
4C-4 / 4C-3 rollbacks, and the full 4C-6 → 4C-5 → 4C-4 → 4C-3 chain.

### If the 4C-6 migration fails

It is one `DO` block: nothing was changed. Its preflight lists, per
relationship, rows pointing at another business's (or a missing) record,
and product snapshots naming another business's product. It never repairs,
deletes or reassigns anything. Correct each reported row deliberately,
then:

```bash
pnpm --filter @mocha-house/database exec prisma migrate resolve --rolled-back 20261015090000_tenant_fk_catalog_offers_snapshots
pnpm --filter @mocha-house/database exec prisma migrate deploy
```

It takes the same 5-second `lock_timeout` as 4C-3 to 4C-5.

### Rolling back 4C-6

Never automatic. Revert the 4C-6 relations in `schema.prisma` (back to
single-column relations; remove `Campaign.mediaAsset`, `MediaAsset.campaigns`
and the four snapshot indexes) and ship
`prisma/rollbacks/20261015090000_tenant_fk_catalog_offers_snapshots.down.sql`
(one `DO` block) as a new forward migration. It removes only what 4C-6
added (33 composite keys, five indexes, nineteen ownership triggers, the
product reuse guard and the `OrderLine` snapshot trigger), restores the 32
original single-column keys exactly, and restores the two snapshot
functions to their 4C-4 definitions (which re-opens the race above). Roll
back in reverse order: **4C-7, then 4C-6, then 4C-5, then 4C-4, then 4C-3,
then 4C-2.** PostgreSQL refuses a 4C-4 or 4C-3 rollback while 4C-6 is
applied (their functions are still in use).

### Before applying 4C-6 to a persistent database (not done here)

This milestone was validated on fresh, guarded, disposable databases only.
Before any persistent environment:

- **Backup** taken and restore-tested; the rollback migration prepared.
- **Preflight read-only first:** run `integrity:check` (read-only role) and
  resolve every reported row by a human decision. The migration's own
  preflight aborts on the same rows, without repairing.
- **Locks (observed in the independent review):** the migration acquires
  **`ACCESS EXCLUSIVE`** locks on several catalog-related tables —
  including `Product`, `Location`, `Category`, `Menu`, `MenuProduct`,
  `Promotion` and `Campaign` (replacing a foreign key locks both tables) —
  plus `SHARE ROW EXCLUSIVE` and `SHARE` locks on the order-history
  snapshot tables (trigger creation and index builds). Locks are held until
  the single migration transaction commits or rolls back. `ACCESS
  EXCLUSIVE` blocks **reads as well as writes**: storefront and menu
  requests, checkout and admin catalog screens wait for the whole
  migration.
- **`lock_timeout` is not a duration limit.** The 5-second `lock_timeout`
  only limits how long the migration *waits to acquire* each lock (it then
  fails fast and atomically; retry after `migrate resolve --rolled-back`).
  It does not bound how long an acquired lock is held: that is the time
  needed to validate every existing row and build the indexes.
- **Timing:** the durations seen on small synthetic databases do not
  predict production duration, which depends on data volume, hardware and
  concurrent load.
- **Approval required:** a persistent-environment migration needs a
  separately approved maintenance window, a backup, the integrity
  preflight, a rollback / recovery plan and a customer-impact assessment
  (storefront and checkout unavailable for the duration). None of this has
  been done.
- **Database roles:** see "Least-privilege considerations (T-2)" below.
- **Migration runner:** must ship `packages/database/src` with
  `prisma.config.ts` (the F-1 guard), as for every migration since F-1.
- **Order:** 4C-3, 4C-4 and 4C-5 must already be applied (enforced).

### Least-privilege considerations (T-2)

The snapshot functions (`reject_cross_tenant_snapshot()`,
`reject_reused_snapshot_source()`) are ordinary (`SECURITY INVOKER`)
functions: they run with the privileges of the role writing the row.
Observed on a disposable database with a non-owner role:

- A role that **writes snapshots** (checkout, redemptions) needs `SELECT`
  on the source table and `UPDATE` on at least one of its columns, because
  `SELECT … FOR KEY SHARE` requires it. Since 4C-6 this applies to
  `Product` **and** to the existing 4C-4 snapshot sources (`Promotion`,
  `LoyaltyReward`, `LoyaltyBonusPromotion`, `GiftCard`), which 4C-4 only
  read. Without it the write fails with "permission denied".
- A role that **inserts a source row or changes its id** (for example
  catalog administration creating a product) needs `SELECT` on every
  snapshot table that may name it (for `Product`: `OrderLine`,
  `OrderLoyaltyBonusItem`, `OrderLoyaltyRewardRedemption`,
  `OrderPromotionRedemption`).
- A non-owner role could not bypass the guards (no `DISABLE TRIGGER`,
  `session_replication_role`, constraint drop, function replacement or
  `TRUNCATE`); a temporary table shadowing a snapshot table does not hide
  history (the functions name the schema). The **owner / superuser
  bypass remains** and is what T-2 closes.

Before deploying with a non-owner runtime role, validate these permissions
for `Product`, the existing snapshot source tables and the referencing
snapshot tables on a disposable database. Two approaches to weigh during
T-2 (neither is implemented now):

- **Explicit privileges** — grant the runtime role the `SELECT` / `UPDATE`
  (column-level `UPDATE` is enough) the functions need. Simple and
  transparent, but it widens what the runtime role may do directly.
- **Carefully audited `SECURITY DEFINER` functions** — owned by the
  migration role with a pinned `search_path`, so the runtime role needs no
  extra table privileges. Narrower runtime grants, but the functions then
  run with owner rights and must be reviewed as privileged code.

### Design notes

- **Snapshots stay foreign-key-free on purpose.** A foreign key would block
  deleting a product with order history, or erase the history. The
  combination "validated on write + id never reused by another business +
  validated under lock" gives the isolation guarantee of a key while
  keeping history.
- **One guard per source table.** The reuse guard takes several
  (table, column) pairs, so a fifth product snapshot is one more argument
  and one more index, not a new trigger.
- **Composite relations change Prisma's write surface.** Nested creates
  must not carry `tenantId`, and `disconnect` is unusable on optional
  composite relations. TypeScript catches the first only outside
  `.map()` object literals; the runtime tests catch the rest.

## Tenant-enforced operations, careers, franchising and notifications (Security 4C-7)

Migration `20261016090000_tenant_fk_operations_careers_notifications` is the
last planned composite-foreign-key milestone. It replaces the last ten
single-column foreign keys between business-owned records with composite
ones, `("tenantId", col) -> parent ("tenantId", "id")`, `ON UPDATE
RESTRICT`:

| Relationship | Parent | On delete |
| --- | --- | --- |
| `ChecklistTemplateItem.templateId` | ChecklistTemplate | CASCADE |
| `ChecklistInstance.templateId` | ChecklistTemplate | RESTRICT |
| `ChecklistInstance.locationId` | Location | RESTRICT |
| `ChecklistInstanceItem.checklistInstanceId` | ChecklistInstance | CASCADE |
| `OperationsTask.locationId` | Location | RESTRICT |
| `JobOpening.locationId` (optional) | Location | RESTRICT |
| `JobApplication.jobOpeningId` | JobOpening | RESTRICT |
| `JobApplicationNote.jobApplicationId` | JobApplication | CASCADE |
| `FranchiseInquiryNote.franchiseInquiryId` | FranchiseInquiry | CASCADE |
| `NotificationDelivery.outboxEventId` | OutboxEvent | RESTRICT |

- **Delete behaviour is unchanged** (no intended exception this time);
  `ON UPDATE` became RESTRICT (was CASCADE): ids never change. Every child
  column was already indexed, so no index is added.
- **Ownership:** the last twelve business-owned tables without it now
  reject any change of `tenantId` (`<Table>_tenantId_immutable`, SQLSTATE
  `23001`): `ChecklistTemplate`, `ChecklistTemplateItem`,
  `ChecklistInstance`, `JobOpening`, `JobApplication`, `FranchiseInquiry`,
  `OutboxEvent`, `NotificationDelivery`, `NotificationRecipient`,
  `CmsPage`, `GiftCardConfiguration` and `LoyaltyConfiguration`. After
  4C-7 **every table with a `tenantId` column (64) carries the trigger**,
  and **no single-column foreign key between business-owned tables is
  left**. What CI now detects is listed under "What CI detects after
  4C-7" below.
- **Requires** 4C-3's `reject_tenant_reassignment()` (it refuses to run
  without it) and drops nothing of earlier milestones.
- **Application changes:** job-opening editing sets and clears the location
  through the `locationId` column (a relation `disconnect` would clear
  `tenantId` and is refused); the checklist-instance nested item create no
  longer passes `tenantId` (Prisma takes it from the instance). Application
  code now contains no relation `disconnect` at all (tripwire test).
- **Considered and not done:** making `NotificationDelivery`'s copy of the
  event's aggregate (`aggregateType` / `aggregateId`) provably equal to its
  event's — possible with a wider composite key on `OutboxEvent`, but it
  adds a unique index on the busiest write table to guard a value the worker
  copies from the event it was handed; the delivery is now tied to an event
  of its own business, and the integrity checker verifies the copy. Revisit
  if deliveries are ever written from anything but the event.
- `tenant-fk-operations-careers-notifications.spec.ts` proves, with three
  fictional businesses: same-business writes accepted for all ten
  relationships; every cross-business reference rejected on the exact
  constraint (direct SQL, six business pairs, insert and update); every
  move of the twelve tables rejected (one row or all rows); 31 Prisma write
  shapes × 6 pairs (checked and unchecked, nested create / connect from
  either side, upsert, updateMany) refused with the data unchanged; the
  operational workflows (nested checklist items, tasks, job openings with
  location set and cleared, applications, notes, outbox events and
  deliveries); concurrency (a child in flight share-locks its parent
  against delete and move; twelve parallel inserts — only the six
  same-business ones succeed); delete outcomes identical to a pre-4C-7
  database; the integrity checker `CLEAN`; every removed key or trigger
  detected by both the per-object and the whole-database guard; and, with
  real `prisma migrate deploy`: success without drift, preflight abort with
  separate "another business" / "missing" counts and recovery, missing-4C-3
  refusal, late failure, lock timeout, the refused 4C-3 rollback, rollback
  and re-apply, and the full 4C-7 → 4C-6 → 4C-5 → 4C-4 → 4C-3 chain.

### If the 4C-7 migration fails

It is one `DO` block: nothing was changed. Its preflight lists, per
relationship, how many rows name another business's record and how many
name a missing one. It never repairs, deletes or reassigns anything.
Correct each reported row deliberately, then:

```bash
pnpm --filter @mocha-house/database exec prisma migrate resolve --rolled-back 20261016090000_tenant_fk_operations_careers_notifications
pnpm --filter @mocha-house/database exec prisma migrate deploy
```

### Rolling back 4C-7

Never automatic. Revert the 4C-7 relations in `schema.prisma` and ship
`prisma/rollbacks/20261016090000_tenant_fk_operations_careers_notifications.down.sql`
(one `DO` block) as a new forward migration. It removes only what 4C-7
added (ten composite keys, twelve ownership triggers) and restores the ten
original single-column keys exactly (including `ON UPDATE CASCADE`); it
keeps 4C-3's function. Roll back in reverse order: **4C-7, then 4C-6, then
4C-5, then 4C-4, then 4C-3, then 4C-2.** PostgreSQL refuses a 4C-3 rollback
while 4C-7 is applied; a 4C-6 / 4C-5 / 4C-4 rollback shares no object with
4C-7 and is not refused, so the order is a procedure — follow it.

### Before applying 4C-7 to a persistent database (not done here)

The same rules as 4C-6 ("Before applying 4C-6 to a persistent database")
apply — backup, read-only integrity preflight, rollback / recovery plan,
customer-impact assessment, a separately approved maintenance window — and
4C-6 must be applied first. Observed locks: **`ACCESS EXCLUSIVE`** on
`Location`, `OutboxEvent`, `ChecklistTemplate`, `ChecklistTemplateItem`,
`ChecklistInstance`, `ChecklistInstanceItem`, `OperationsTask`,
`JobOpening`, `JobApplication`, `JobApplicationNote`, `FranchiseInquiry`,
`FranchiseInquiryNote` and `NotificationDelivery`, plus `SHARE ROW
EXCLUSIVE` on the configuration tables, all held until the migration
commits. `Location` and `OutboxEvent` make this an outage for **reads and
writes**: storefront location and menu requests, checkout (every order
writes an outbox event) and the notification worker wait for the whole
migration. The 5-second `lock_timeout` limits only the wait to acquire a
lock. Synthetic timings do not predict production. For a large persistent
database, a staged variant (add the new keys `NOT VALID`, validate them in
a separate transaction under `SHARE UPDATE EXCLUSIVE`, then drop the old
keys) would shorten the exclusive window; it is a deployment decision, not
implemented.

### Remaining tenant references after 4C-7 (complete inventory)

All 105 references between business-owned records in
`relationship-inventory.ts`:

| Kind | Count | Protection |
| --- | --- | --- |
| Composite foreign key | 86 | **All tenant-enforced by PostgreSQL** (4C-3 … 4C-7). |
| Historical snapshot | 8 | No foreign key by design (history outlives its source). New or changed values must name a same-business source, validated under a row lock; a deleted source id cannot be reused by another business while history names it: `OrderLine.productId`, `OrderLoyaltyBonusItem.productId`, `OrderLoyaltyRewardRedemption.freeItemProductId`, `OrderPromotionRedemption.freeItemProductId` (4C-6); `OrderLoyaltyRewardRedemption.sourceRewardId`, `OrderLoyaltyBonusItem.sourcePromotionId`, `OrderPromotionRedemption.sourcePromotionId`, `OrderGiftCardRedemption.sourceGiftCardId` (4C-4). |
| Polymorphic | 4 | Not database-enforced (the target table depends on a type column): `InternalAuditEvent.targetId`, `ApprovalRequest.targetId`, `OutboxEvent.aggregateId`, `NotificationDelivery.aggregateId`. Written only by server code from tenant-scoped records; verified by `integrity:check` (unknown types are violations). |
| JSON reference | 6 | Not database-enforced: `CmsPage.draftContent` / `publishedContent` (hero image — checked by `integrity:check` and validated on write), and snapshots never joined: `OrderLine.selections`, `OutboxEvent.payload`, `InternalAuditEvent.beforeData` / `afterData`. |
| External identifier | 1 | `NotificationDelivery.providerMessageId` — a provider's id, never a business record. |

### What CI detects after 4C-7

Two layers, each proven to fail on purpose-built mutations (Security 4C-7
review: scratch copies of the schema and fresh guarded disposable
databases):

- **Schema (`tenant-relationship-inventory.spec.ts`):**
  - every Prisma model must declare `tenantId`, except the approved global
    models pinned in the test (`APPROVED_GLOBAL_MODELS`, today only
    `Tenant`), and `MODEL_TENANCY`'s `platform` set must equal that list —
    so a new global model cannot enter silently, whichever way it is
    classified (`MODEL_TENANCY` is a `Record` over every model, so an
    unclassified model is already a type error);
  - an approved global model may hold no reference to a business record
    (no relation, no `…Id` column);
  - every relation or `…Id` column between business-owned models must be
    classified, and every foreign-key relation must be a `(tenantId,
    column)` composite.
- **Live database catalog (`tenant-fk-operations-careers-notifications.spec.ts`,
  against the migrated CI database):**
  - every table with a `tenantId` has its ownership trigger;
  - no foreign key between business-owned tables omits `tenantId`;
  - no table lacks a `tenantId` except `Tenant` and Prisma's internal
    `_prisma_migrations` history table (so a table created by a migration
    or raw SQL outside Prisma is caught too);
  - no table without a `tenantId` references a business-owned table.

Mutations that fail CI: a new model without `tenantId`; a model without
`tenantId` that references `Location`; `Tenant` gaining a `…Id` column; a
new single-column relation between business models; a table without
`tenantId` (with or without a foreign key into a business table); a
business table without the ownership trigger; a business table with a
single-column foreign key. The unmodified schema and database pass.

**Not detected by these guards:** what queries *read* (see below);
references that are not foreign keys or `…Id` columns of a model (for
example ids inside JSON or text fields added later, or values sent to an
external system); objects outside the `public` schema; and anything done
with owner rights (disabling triggers, dropping keys — T-2).

**What this does not mean.** Every *relationship* is now tenant-safe in
PostgreSQL, but tenant isolation is not complete:

- **Reads are not database-enforced.** Which business's rows a query
  *returns* is decided by application code (tenant-scoped Prisma queries).
  The tenant query audit (`TENANT_QUERY_AUDIT`) only *reports* queries
  without a tenant predicate; it never blocks one. A missing `where:
  { tenantId }` in a new read path is caught only by tests and review.
- **Raw SQL:** six `$queryRaw` row locks (`SELECT … FOR UPDATE` by id on
  `CustomerLoyaltyAccount`, `GiftCard`, `ChecklistTemplate`,
  `ChecklistInstance`) take ids that tenant-scoped queries returned just
  before; they lock, never return data. No other raw SQL in application
  code.
- **Owner bypass (T-2):** the runtime role owns the tables and could
  disable the triggers or drop the keys.
- **Polymorphic and JSON references** above are verified after the fact,
  not prevented.
- **Polymorphic deleted-id reuse (found in the 4C-7 review):** if a
  record named by a polymorphic reference (for example the
  `FranchiseInquiry` an `OutboxEvent` or audit entry names) were deleted
  and its id re-inserted for another business, the old reference would
  name the other business's record — the polymorphic counterpart of the
  4C-4 snapshot finding. Not reachable through the application today
  (these records are never deleted, ids are server-generated, and every
  worker lookup also filters by the event's own `tenantId`); the integrity
  checker reports it. A reuse guard like 4C-6's is possible if deletion of
  these records is ever introduced.
- **Staff identity (T-1):** one login can still span businesses.
- **Persistent environments:** none of 4C-3 … 4C-7 protects an
  environment until it is applied there and verified (see the persistent
  migration prerequisites above).

### Post-4C security roadmap (proposal, not implemented)

Recommended order — each step small, independently shippable, and chosen
to get back to product work quickly without weakening isolation:

1. **Persistent-environment rollout of 4C-3 … 4C-7** (deployment, not
   code): one approved maintenance window, backup, `integrity:check`
   preflight, apply, verify, smoke-test. Until then production is protected
   by application checks only.
2. **T-2 — least-privilege runtime role.** Migrations as the owner; the API
   and worker as a non-owner DML-only role; the integrity checker read-only.
   This turns every database guard of 4C-3 … 4C-7 from "honest-mistake
   proof" into "compromised-app proof". Includes the snapshot-function
   privileges (explicit grants vs audited `SECURITY DEFINER`). Small code
   change, mostly configuration and a CI job running the suite as that
   role.
3. **T-1 — one staff login per business** (approved direction): removes
   cross-business switching and automatic email binding. The largest
   remaining *authorization* risk.
4. **Read isolation in the database — Row-Level Security**, enabled
   table by table as defence in depth, keyed on a per-transaction
   `app.tenant_id` set by the Prisma tenant context. Only meaningful after
   T-2 (the owner bypasses RLS) and after the query audit shows no
   un-scoped queries. In the meantime, switch the tenant query audit from
   *report* to *enforce* model by model (cheaper, catches the same bug
   class in the application).
5. **Independent penetration and tenant-isolation test** once 1–3 are in
   place, against a staging environment with several fictional businesses.

Product work can resume after step 1 alongside steps 2–3; steps 4–5 can run
in parallel with feature development.

## Concurrent access changes (Security follow-up F-2)

Access changes — assigning access, removing one assignment, changing a
person's status — run in one SERIALIZABLE transaction, so simultaneous
requests can never produce a state no sequential order could (duplicate
grants, a business left without an administrator). PostgreSQL resolves such
races by aborting all but one transaction (serialization failure 40001, or a
deadlock 40P01); previously the loser surfaced as HTTP 500.
`runSerializable` (`apps/api/src/prisma/serializable-transaction.ts`) now
re-runs a transaction that lost a race from a fresh snapshot (bounded:
8 attempts, jittered backoff capped at 250 ms), so each request gets the
answer it would get on its own: 201 for the grant that is created, the
ordinary 409 "already has that access" for identical ones, the ordinary 404
for a removal of an already-removed assignment. A unique violation on the
assignment keys while assigning means "re-decide from fresh data" and is
re-run the same way.

- Serialization failures arrive in three shapes with Prisma 7 and the pg
  adapter, all recognised: P2034 (a statement), a bare `DriverAdapterError`
  of kind `TransactionWriteConflict` (at COMMIT, no Prisma code at all), and
  a raw SQLSTATE 40001 / 40P01 on the driver error.
- Business decisions (409, 404, 403 …) are never retried, and no other
  database error is converted: P2034 is **not** a 409.
- After 8 lost races the request fails with a generic 503 ("could not be
  completed because of other changes made at the same time") and changes
  nothing. No response ever contains a database error.
- **Future observability (optional, not required):** retries and exhaustion
  are not logged today, and the 503 does not keep the underlying error. A
  server-side warning on exhaustion (with the SQLSTATE, never sent to the
  client) would make persistent contention visible to operators; an optional
  `Retry-After` header could accompany the 503.
- `apps/api/src/internal-users/admin-internal-user-concurrency.spec.ts`
  races 12 identical grants, overlapping location grants, 12 identical
  removals, grants against removals, and two administrators removing each
  other's last administrator access.

## Tracked security follow-ups (Security 4C-5 review)

Recorded by the independent Security 4C-5 review. None of these blocks
merging Security 4C-5; each has an owner milestone and a deadline below.
They are tracked here until each is closed by implementation, tests and
review.

### Prerequisites for the next development milestone

| # | Follow-up | Why | Done when |
| --- | --- | --- | --- |
| F-1 | **Harden disposable-database test commands.** — *Resolved by the F-1/F-2 change: Prisma commands are guarded (see "Prisma commands are guarded too"); pending review.* | The local command sequence under "Running the same checks locally" (and any ad-hoc script) runs the next command even when `db:create-disposable` refuses the database; `prisma migrate deploy` then **creates and migrates an unguarded database**. Observed during the 4C-5 review on a local, disposable server (database dropped unused). CI is not affected: each step is a separate job step and a failure stops the job. | The documented sequence stops on the first failure (for example `set -euo pipefail` or one script that exits on a refused guard), and `migrate deploy` / `db seed` in test tooling refuse a database the guard has not approved. |
| F-2 | **Map concurrent role-assignment conflicts to controlled API responses.** — *Resolved by the F-1/F-2 change: Serializable access changes re-run lost races (see "Concurrent access changes"); pending review.* | Under concurrent identical assignments the database keeps exactly one grant (Serializable transaction + `InternalUserRoleAssignment_corporate_grant_key`), but a losing request can surface an unmapped Prisma `P2034` (serialization failure) as HTTP 500 instead of 409. Integrity is not affected. | Serialization failures and unique violations on assignment return the same 409 as a sequential duplicate, with a test. |
| F-3 | **Security 4C-6 product-snapshot finding** (see "SECURITY FINDING (4C-4)" above). — *Resolved in code by Security 4C-6 (merged): reuse guard on all four product snapshots, locked validation, prevention test, confirmed by independent review. Persistent environments are protected only after the migration is applied and verified there.* | Deleted product ids can be reused by another business while a kept snapshot names them. | Closed by 4C-6 as stated in that finding. It is the next security milestone's mandatory deliverable. |

### Prerequisites for onboarding a second production business

| # | Follow-up | Why | Done when |
| --- | --- | --- | --- |
| T-1 | **Tenant-bound staff authentication** (separate identity milestone; approved direction). | Today one verified login may hold an `InternalUser` row in several businesses and switch between them with `X-Tenant-Id` (membership is re-validated on every request, so this is not an exploit, but it contradicts the approved single-tenant staff login policy). An ACTIVE, not-yet-bound `InternalUser` row in another business carrying a person's verified email **automatically attaches that person's existing login** to that business. | Each staff login belongs to exactly one business, carried as a trusted, server-set claim and checked against `InternalUser.tenantId`; cross-business switching (`X-Tenant-Id`, business chooser) and automatic cross-tenant email binding are removed; invitations are single-use and tenant-bound; recovery and deactivation are tenant-scoped; CENTERIVO platform administrators use a separate identity and authorization domain. |
| T-2 | **Non-owner, least-privilege application database role.** | The runtime role owns the tables. Verified in review: a non-superuser **owner** cannot use `session_replication_role` or disable foreign-key system triggers, but **can** disable the ownership triggers (`ALTER TABLE … DISABLE TRIGGER USER`) and drop the composite foreign keys — including the 4C-6 product-snapshot guards and every 4C-7 key and trigger. The snapshot functions also need specific runtime privileges (see "Least-privilege considerations (T-2)"). | Migrations run as a dedicated owner role; the application runs as a NOSUPERUSER, non-owner role with DML privileges only (no DDL, no `TRUNCATE`); the integrity checker uses a read-only role; verified on a disposable database. |
| T-3 | **F-3 closed** (Security 4C-6). — *Resolved in code (4C-6 merged); pending applying and verifying the migration in the environment concerned.* | As above. | As above. |

### Product decision (not a tenant-isolation prerequisite)

| # | Follow-up | Why | Done when |
| --- | --- | --- | --- |
| P-1 | **Inactive-location authorization policy.** | A LOCATION grant on a **deactivated** location still authorizes actions at that location and appears in the person's access summary (`AuthorizationService` loads every location of the business, active or not). This stays inside one business; it is a product question, not a cross-tenant risk. | Product decides whether grants on inactive locations stay effective, become read-only, or are ignored; the decision is implemented with tests, at the latest with the custom roles / location groups work. |

## Running the same checks locally

```bash
set -euo pipefail   # stop at the first failure
pnpm install --frozen-lockfile
# build packages in the order listed above, then create a NEW test database
# (DATABASE_URL must name a database that does not exist yet). Even without
# `set -e`, migrate / seed refuse a database the guard has not approved
# (Security F-1):
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
