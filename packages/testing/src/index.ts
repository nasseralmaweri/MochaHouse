// Shared TEST-ONLY helpers for the Mocha House workspace. Consumed only as a
// devDependency by app test suites — never by application source.
export {
  TEST_TENANT_B_ID,
  TEST_TENANT_B_NAME,
  TEST_TENANT_B_SLUG,
  createTestTenantB,
  removeTestTenantB,
  TEST_TENANT_C_ID,
  TEST_TENANT_C_NAME,
  TEST_TENANT_C_SLUG,
  createTestTenantC,
  removeTestTenantC,
  removeTestTenant,
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
export {
  DISPOSABLE_NAME_SETTING,
  DISPOSABLE_TOKEN_SETTING,
  DisposableDatabaseError,
  SCRATCH_DATABASE_PREFIX,
  TEST_DATABASE_FLAG_ENV,
  TEST_DATABASE_TOKEN_ENV,
  assertApprovedTestTenants,
  assertDeletableTestTenantId,
  assertDisposableDatabase,
  assertTestEnvironment,
  assertUnambiguousTestUrl,
  createDisposableDatabase,
  dropDisposableDatabase,
  isTestDatabaseName,
  type DisposableDatabaseIdentity,
} from "./disposable-database";
