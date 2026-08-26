// Single source of truth for the Prisma schema and generated client,
// shared by every app that talks to Postgres (apps/api, apps/worker).
// Each app still owns its own thin NestJS PrismaService (connect on
// module init, disconnect on module destroy) — this package only owns the
// schema, migrations, and generated client, not the app-lifecycle wiring.
export { PrismaClient, Prisma } from './generated/prisma/client';
