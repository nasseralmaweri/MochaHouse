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
   (`pg_db_role_setting`) carry `centerivo.disposable_database` equal to its
   name and `centerivo.disposable_token` equal to the run's token. Only
   `createDisposableDatabase` writes the marker, and only onto a database it
   has just created — an existing database is never marked, and a restored
   dump does not carry it.
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
candidates — 82 existing foreign keys and 3 plain columns — 8 historical
snapshots, 5 polymorphic references, 6 JSON columns, 1 external id).
`tenant-relationship-inventory.spec.ts` fails when the schema gains, loses or
changes one without a classification.

`pnpm --filter @mocha-house/database integrity:check` reports, read-only,
references that point at another business, at nothing, or contradict their
type. It runs in a `READ ONLY` transaction (SELECT privileges suffice),
prints counts by relationship type and primary keys only, never the
connection string, and exits 1 on violations. CI runs it on every freshly
seeded database in the tenant isolation job.

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
