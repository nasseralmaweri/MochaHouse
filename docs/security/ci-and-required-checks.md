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
| **Tenant isolation and route inventory** | The route inventory (every registered API route classified), every `src/tenancy/` suite — three-business isolation, checkout financial isolation, storefront isolation, read isolation, phase 2/3/4A suites and the phase 2 migration regression tests — and the worker's tenancy suites |
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

## Running the same checks locally

```bash
pnpm install --frozen-lockfile
# build packages in the order listed above, then, with DATABASE_URL pointing
# at a disposable database:
pnpm --filter @mocha-house/database exec prisma migrate deploy
pnpm --filter @mocha-house/database exec prisma db seed
(cd apps/api && pnpm test)
(cd apps/worker && pnpm test)
(cd apps/web && pnpm test)
node scripts/ci/lint-changed.mjs origin/main
```
