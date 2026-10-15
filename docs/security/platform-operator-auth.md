# CENTERIVO platform-operator authentication (SC1a)

Status: implemented behind configuration. **Not active in any environment
until the platform Cognito pool exists and the migration is applied — both
require explicit owner approval.**

## What it is

Platform operators administer the CENTERIVO SaaS platform itself. They are
**not** tenant staff: they have no tenant, no tenant membership and no tenant
role. A tenant's seeded `platform-administrator` role is a *tenant* role and
confers nothing on the platform boundary.

| | Customers | Tenant staff | Platform operators |
|---|---|---|---|
| Routes | storefront `/api/v1/*` | `/api/v1/admin/*`, `/api/v1/internal/*` | `/api/v1/platform/*` |
| Guard | `CustomerAuthGuard` | `InternalAuthGuard` | `PlatformAuthGuard` |
| Cognito pool | customer pool | internal pool | **dedicated platform pool** |
| Dev provider switch | `AUTH_PROVIDER` | `INTERNAL_AUTH_PROVIDER` | `PLATFORM_AUTH_PROVIDER` |
| Identity record | `Customer` (per tenant) | `InternalUser` (per tenant) | `PlatformOperator` (global) |

## Request flow (`PlatformAuthGuard`)

1. Bearer token verified against the **platform** provider only — the
   dedicated pool's JWKS (issuer, audience = platform app client,
   `token_use=id`, signature, expiry), or the dev provider in a verified safe
   development context. Missing, malformed, wrong pool/audience, expired →
   **401**. Platform auth not configured, or configured with the customer or
   staff pool/client → **503** (fail closed; no detail in the response).
2. The `PlatformOperator` for the verified `(externalProvider,
   externalSubject)` is re-read on **every** request. Never matched by email.
   Unknown or `DISABLED` → the same generic **403**, plus a
   `platform.access.denied` audit event.
3. `X-Tenant-Id` and every other client value are ignored; no
   `TenantContext` is ever established. The routes are excluded from the
   tenant middleware (`PLATFORM_ROUTES`), so the storefront tenant — and its
   suspension (SC0.5a) — never applies to them.

A platform token never verifies at the customer or staff boundary (different
pool/audience; in dev, different secret and marker), and vice versa.

`GET /api/v1/platform/me` returns the operator profile (id, email, display
name, status — never the identity subject or token claims), records
`platform.session.verified` and the observational `lastAuthenticatedAt`.

## MFA

**Production MFA enforcement depends on the platform Cognito pool's
configuration.** Cognito ID tokens do not state whether MFA was used, so the
API cannot verify it per token. The pool must be configured as below and
that configuration must be verified (and kept under change control) before
the boundary is used. The dev provider requires an explicit `mfa: true`
claim so the tests prove that an identity without MFA is refused.

## Required platform Cognito configuration (to be created by an administrator)

- A **new user pool**, separate from the customer and internal pools.
- MFA **REQUIRED**, TOTP (software token); SMS MFA not used.
- Self-service sign-up **disabled** (admin-create-user only).
- One app client: public (no secret), only the auth flows the platform
  sign-in will use, no hosted-UI sign-up.
- Strong password policy; advanced security/threat protection recommended.

Environment (API): `PLATFORM_AUTH_PROVIDER=cognito` (or unset),
`PLATFORM_COGNITO_USER_POOL_ID`, `PLATFORM_COGNITO_CLIENT_ID`. Startup
refuses a platform pool/client that equals the customer or internal one, a
pool without its client (or vice versa), `PLATFORM_AUTH_PROVIDER=dev` or a
`PLATFORM_AUTH_DEV_JWT_SECRET` in a production-like environment. The pool is
optional at startup; until it is configured every platform request is 503.

## Provisioning (CLI only)

No API, no self-registration, no seed creates an operator. After the user
exists in the platform pool (with MFA), an administrator runs:

```
DATABASE_URL=... pnpm --filter @mocha-house/database platform:operator \
  create --confirm-database <db name> --email <email> \
  --provider cognito-platform --subject <pool user sub> --status ACTIVE
```

`disable` / `enable --email <email>` and `list` are also available.
`--confirm-database` must equal the database named in `DATABASE_URL`. Every
change writes a `PlatformAuditEvent` in the same transaction. A
`platform-dev` operator cannot be created in a production-like environment.

## Data

Migration `20261022090000_platform_operator_foundation` (additive only):
`PlatformOperator`, `PlatformAuditEvent`, two enums. No `tenantId`, no
reference to any business record, no rows inserted. Rollback:
`prisma/rollbacks/20261022090000_platform_operator_foundation.down.sql`
(refuses while any operator or audit event exists).

## Not in SC1a

Platform sign-in endpoint and MFA challenge flow, the platform Admin UI
(SC1b), any tenant lifecycle/provisioning, plans or billing.
