// TEST-ONLY tenant fixtures (Milestone S0C).
//
// Tenant B exists so isolation tests can prove "Tenant A cannot reach
// Tenant B" (S0B security requirement). It is NOT an operational tenant:
//   - it is created only by a test and removed by that test's cleanup;
//   - nothing resolves it — the API and worker operate solely as the tenant
//     named by SINGLE_TENANT_ID (Tenant #1), and no request input can select
//     another tenant;
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
