// Security 4C-1 — the disposable-database guard. Implemented in
// @mocha-house/database (src/testing/disposable-database.ts) so that
// package's prisma.config.ts can enforce it on every Prisma command
// (Security follow-up F-1); re-exported here unchanged for test code.
export * from "@mocha-house/database/dist/testing/disposable-database";
