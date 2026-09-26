import {
  TENANT_1_MOCHA_HOUSE_ID,
  TENANT_1_MOCHA_HOUSE_NAME,
  TENANT_1_MOCHA_HOUSE_SLUG,
} from './well-known-tenants';

// The minimal client surface needed, so the seed's own PrismaClient and an
// app's PrismaService can both call this.
interface TenantUpsertClient {
  tenant: {
    upsert(args: {
      where: { id: string };
      update: Record<string, never>;
      create: {
        id: string;
        slug: string;
        name: string;
        status: 'ACTIVE';
      };
    }): Promise<{ id: string }>;
  };
}

// Idempotently ensures Tenant #1 (Mocha House) exists with its FIXED id.
// Create-once: an existing row is never modified (`update: {}`), so a
// re-seed can never re-activate a tenant that was suspended, or rename it.
// The migration already inserts this row; this covers databases reset
// through the seed. Bootstrap-only — never called on a request path.
export async function ensureTenantOne(client: TenantUpsertClient): Promise<string> {
  const tenant = await client.tenant.upsert({
    where: { id: TENANT_1_MOCHA_HOUSE_ID },
    update: {},
    create: {
      id: TENANT_1_MOCHA_HOUSE_ID,
      slug: TENANT_1_MOCHA_HOUSE_SLUG,
      name: TENANT_1_MOCHA_HOUSE_NAME,
      status: 'ACTIVE',
    },
  });
  return tenant.id;
}
