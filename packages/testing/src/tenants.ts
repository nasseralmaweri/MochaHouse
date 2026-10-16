import { randomUUID } from 'node:crypto';
import {
  createTenantContext,
  type TenantContext,
  type TenantPrincipalType,
} from '@mocha-house/database';
import {
  assertDeletableTestTenantId,
  assertDisposableDatabase,
} from './disposable-database';

// TEST-ONLY tenant fixtures (Milestone S0C).
//
// Tenant B exists so isolation tests can prove "Tenant A cannot reach
// Tenant B" (S0B security requirement). It is NOT an operational tenant:
//   - it is created only by a test and removed by that test's cleanup;
//   - public / customer API requests and the worker never resolve it (they
//     operate as SINGLE_TENANT_ID, Tenant #1). Since S0F an internal Admin
//     request resolves it only for an identity a test has explicitly made
//     an ACTIVE member of it — never from request input alone;
//   - this package is a devDependency only, and a guard test fails if
//     application source imports it.
//
// Its id is fixed (and visibly a test value — "7e57") so future isolation
// suites can reference it deterministically.
export const TEST_TENANT_B_ID = '01a0db02-f800-7000-8000-7e570000000b';
export const TEST_TENANT_B_SLUG = 'test-tenant-b';
export const TEST_TENANT_B_NAME = 'Test Tenant B (isolation tests only)';

interface TenantFixtureClient {
  tenant: {
    upsert(args: {
      where: { id: string };
      update: Record<string, never>;
      create: { id: string; slug: string; name: string; status: 'ACTIVE' };
    }): Promise<{ id: string }>;
    deleteMany(args: { where: { id: string } }): Promise<{ count: number }>;
  };
  // SC2a — raw statements for the subscription fixtures below.
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

// SC2a — a test business is subscribed to the Founding plan (every module),
// like every business that existed when plans were introduced, so isolation
// suites keep exercising every module. No history row is written (history
// is append-only and would block the business's removal). A no-op on a
// scratch database migrated to before plans existed. The id is a validated
// test-only business id, never caller-supplied text.
async function subscribeToFoundingPlan(
  client: TenantFixtureClient,
  tenantId: string,
): Promise<void> {
  assertDeletableTestTenantId(tenantId);
  await client.$executeRawUnsafe(`
    DO $test_subscription$
    BEGIN
      IF to_regclass('public."TenantSubscription"') IS NOT NULL THEN
        INSERT INTO "TenantSubscription"
          ("id", "subscriberTenantId", "planVersionId", "status", "startedAt", "updatedAt")
        SELECT gen_random_uuid()::text, '${tenantId}', v."id", 'ACTIVE', now(), now()
        FROM "SubscriptionPlanVersion" v
        JOIN "SubscriptionPlan" p ON p."id" = v."planId"
        WHERE p."key" = 'founding' AND v."version" = 1
        ON CONFLICT ("subscriberTenantId") DO NOTHING;
      END IF;
    END
    $test_subscription$`);
}

// SC2a — removes a test business's subscription and add-ons (a business
// with subscription history cannot be removed: the history is append-only).
async function removeSubscription(
  client: TenantFixtureClient,
  tenantId: string,
): Promise<void> {
  assertDeletableTestTenantId(tenantId);
  await client.$executeRawUnsafe(`
    DO $test_subscription_removal$
    BEGIN
      IF to_regclass('public."TenantSubscription"') IS NOT NULL THEN
        DELETE FROM "TenantModuleGrant" g
          USING "TenantSubscription" s
          WHERE g."subscriptionId" = s."id" AND s."subscriberTenantId" = '${tenantId}';
        DELETE FROM "TenantSubscription" WHERE "subscriberTenantId" = '${tenantId}';
      END IF;
      -- SC3c-3 — the business's billing contact (references its staff).
      IF to_regclass('public."TenantBillingContact"') IS NOT NULL THEN
        DELETE FROM "TenantBillingContact" WHERE "tenantId" = '${tenantId}';
      END IF;
    END
    $test_subscription_removal$`);
}

// Idempotent: returns the fixed Tenant B id whether or not it existed.
export async function createTestTenantB(client: TenantFixtureClient): Promise<string> {
  await assertDisposableDatabase();
  const tenant = await client.tenant.upsert({
    where: { id: TEST_TENANT_B_ID },
    update: {},
    create: {
      id: TEST_TENANT_B_ID,
      slug: TEST_TENANT_B_SLUG,
      name: TEST_TENANT_B_NAME,
      status: 'ACTIVE',
    },
  });
  await subscribeToFoundingPlan(client, tenant.id);
  return tenant.id;
}

// Always call from the creating test's cleanup, so Tenant B never lingers
// in a shared development database.
export async function removeTestTenantB(client: TenantFixtureClient): Promise<void> {
  await removeTestTenant(client, TEST_TENANT_B_ID);
}

// Security 4C-1 — the only way the shared helpers delete a business: the
// id must be a test-only business (never Mocha House / Tenant #1) and the
// database must be proven disposable first.
export async function removeTestTenant(
  client: TenantFixtureClient,
  tenantId: string,
): Promise<void> {
  assertDeletableTestTenantId(tenantId);
  await assertDisposableDatabase();
  await removeSubscription(client, tenantId);
  await client.tenant.deleteMany({ where: { id: tenantId } });
}

// Security 4B — a THIRD test-only business, so isolation suites can prove
// every pair (A↔B, A↔C, B↔C) — including pairs where neither business is
// Mocha House. Same rules as Tenant B: created and removed by the test that
// uses it, never resolved by application code on its own. Distinct from the
// suspended "Tenant C" the S0F tenant-resolution spec defines locally.
export const TEST_TENANT_C_ID = '01a0db02-f800-7000-8000-7e5700000c0c';
export const TEST_TENANT_C_SLUG = 'test-tenant-c';
export const TEST_TENANT_C_NAME = 'Test Tenant C (isolation tests only)';

export async function createTestTenantC(client: TenantFixtureClient): Promise<string> {
  await assertDisposableDatabase();
  const tenant = await client.tenant.upsert({
    where: { id: TEST_TENANT_C_ID },
    update: {},
    create: {
      id: TEST_TENANT_C_ID,
      slug: TEST_TENANT_C_SLUG,
      name: TEST_TENANT_C_NAME,
      status: 'ACTIVE',
    },
  });
  await subscribeToFoundingPlan(client, tenant.id);
  return tenant.id;
}

export async function removeTestTenantC(client: TenantFixtureClient): Promise<void> {
  await removeTestTenant(client, TEST_TENANT_C_ID);
}

// A server-side TenantContext for a test that calls a service directly
// (bypassing the HTTP middleware that normally establishes it). The tenant
// is always passed EXPLICITLY — there is no default tenant. 'anonymous' is
// the principal type the S0C HTTP resolver produces for every request.
export function tenantContextFor(
  tenantId: string,
  principalType: TenantPrincipalType = 'anonymous',
): TenantContext {
  return createTenantContext({
    tenantId,
    principalType,
    requestId: `test-${randomUUID()}`,
  });
}
