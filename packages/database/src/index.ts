// Single source of truth for the Prisma schema and generated client,
// shared by every app that talks to Postgres (apps/api, apps/worker).
// Each app still owns its own thin NestJS PrismaService (connect on
// module init, disconnect on module destroy) — this package only owns the
// schema, migrations, and generated client, not the app-lifecycle wiring.
export { PrismaClient, Prisma } from './generated/prisma/client';

// S0C — tenant foundation (framework-neutral): TenantContext, the model
// tenancy registry, the report-only query audit and single-tenant config.
export * from './tenancy';

// Security 4C-1 — the tenant relationship inventory and the read-only
// integrity checker built on it.
export * from './integrity';

// ESP-02 — the shared production-like environment classifier (NODE_ENV and
// the deployment variables), used by the seed guard and the API's startup and
// request-time gates for dev authentication and simulated payments.
export * from './runtime-environment';

// SC3c-3 — the shared billing email recipient rule (API view and worker
// delivery apply the same one).
export * from './billing/billing-recipient';
