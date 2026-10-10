import { randomUUID } from 'node:crypto';
import {
  createTenantContext,
  type TenantContext,
  type TenantPrincipalType,
} from '@mocha-house/database';

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
}

// Idempotent: returns the fixed Tenant B id whether or not it existed.
export async function createTestTenantB(client: TenantFixtureClient): Promise<string> {
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
  return tenant.id;
}

// Always call from the creating test's cleanup, so Tenant B never lingers
// in a shared development database.
export async function removeTestTenantB(client: TenantFixtureClient): Promise<void> {
  await client.tenant.deleteMany({ where: { id: TEST_TENANT_B_ID } });
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
  return tenant.id;
}

export async function removeTestTenantC(client: TenantFixtureClient): Promise<void> {
  await client.tenant.deleteMany({ where: { id: TEST_TENANT_C_ID } });
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
