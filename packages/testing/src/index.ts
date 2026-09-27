// Shared TEST-ONLY helpers for the Mocha House workspace. Consumed only as a
// devDependency by app test suites — never by application source.
export {
  TEST_TENANT_B_ID,
  TEST_TENANT_B_NAME,
  TEST_TENANT_B_SLUG,
  createTestTenantB,
  removeTestTenantB,
  tenantContextFor,
} from "./tenants";
export {
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  isAppliedAtomically,
  listMigrations,
  withScratchClient,
  type MigrationFile,
  type ScratchDatabase,
} from "./scratch-database";
export { TENANT_ID_REQUIRED_MODELS } from './tenant-conversion';
