import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';

// SC4f-2 — migration 20261111090000_customer_profiles_per_business, on
// scratch databases: existing customers (with their child records) come
// through unchanged; afterwards one login may hold a profile per business
// but never two in the same business; and a rollback that refuses while any
// login holds profiles in more than one business, and otherwise restores
// platform-wide login uniqueness.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const THIS_MIGRATION = '20261111090000_customer_profiles_per_business';
const ROLLBACK = join(
  __dirname,
  `../../../../packages/database/prisma/rollbacks/${THIS_MIGRATION}.down.sql`,
);
const SECOND_TENANT = '01a0db02-f800-7000-8000-00000000f2b2';

jest.setTimeout(180_000);

describe('SC4f-2 customer profiles per business migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  const query = (text: string, params: unknown[] = []) =>
    withScratchClient(scratch.url, (c) =>
      c.query<Record<string, unknown>>(text, params),
    );
  const insertCustomer = (url: string, tenantId: string, subject: string) =>
    withScratchClient(
      url,
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO "Customer" (id, "tenantId", "externalProvider", "externalSubject", email, "updatedAt")
             VALUES (gen_random_uuid()::text, $1, 'cognito', $2, $3, now()) RETURNING id`,
            [tenantId, subject, `${subject}@example.test`],
          )
        ).rows[0].id,
    );
  const insertTenant = (url: string) =>
    withScratchClient(url, (c) =>
      c.query(
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt")
         VALUES ($1, 'sc4f2-second', 'Second Business', 'ACTIVE', now())`,
        [SECOND_TENANT],
      ),
    );
  const indexes = async (url: string) =>
    withScratchClient(url, async (c) =>
      (
        await c.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes WHERE tablename = 'Customer' AND indexname LIKE '%externalSubject%' ORDER BY indexname`,
        )
      ).rows.map((r) => r.indexname),
    );

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4f2_migration',
    );
    const all = listMigrations(MIGRATIONS);
    const at = all.findIndex((m) => m.name === THIS_MIGRATION);
    expect(at).toBeGreaterThan(0);
    // Existing data first, on the schema before this migration ...
    await applyMigrations(scratch.url, all.slice(0, at));
    await insertTenant(scratch.url);
    await withScratchClient(scratch.url, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO "Customer" (id, "tenantId", "externalProvider", "externalSubject", email, "displayName", "marketingEmailOptIn", "updatedAt")
         VALUES ('01a0db02-f800-7000-8000-0000000c0001', $1, 'cognito', 'existing-sub', 'existing@example.test', 'Existing', true, now())
         RETURNING id`,
        [TENANT_1_MOCHA_HOUSE_ID],
      );
      await c.query(
        `INSERT INTO "CustomerLoyaltyAccount" (id, "tenantId", "customerId", balance, "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, 42, now())`,
        [TENANT_1_MOCHA_HOUSE_ID, rows[0].id],
      );
    });
    // ... then this migration and everything after it.
    await applyMigrations(scratch.url, all.slice(at));
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('keeps every existing customer, login and child record unchanged', async () => {
    const { rows } = await query(
      `SELECT c.id, c."tenantId", c."externalProvider", c."externalSubject", c.email, c."displayName", c."marketingEmailOptIn", a.balance
         FROM "Customer" c JOIN "CustomerLoyaltyAccount" a ON a."customerId" = c.id
        WHERE c."externalSubject" = 'existing-sub'`,
    );
    expect(rows).toEqual([
      {
        id: '01a0db02-f800-7000-8000-0000000c0001',
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        externalProvider: 'cognito',
        externalSubject: 'existing-sub',
        email: 'existing@example.test',
        displayName: 'Existing',
        marketingEmailOptIn: true,
        balance: 42,
      },
    ]);
  });

  it('replaces platform-wide login uniqueness with uniqueness per business', async () => {
    expect(await indexes(scratch.url)).toEqual([
      'Customer_tenantId_externalProvider_externalSubject_key',
    ]);
    // The same login may now hold a profile at a second business ...
    await insertCustomer(scratch.url, SECOND_TENANT, 'existing-sub');
    // ... but never a second profile at the same business.
    await expect(
      insertCustomer(scratch.url, TENANT_1_MOCHA_HOUSE_ID, 'existing-sub'),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      insertCustomer(scratch.url, SECOND_TENANT, 'existing-sub'),
    ).rejects.toThrow(/duplicate key/);
    // Children still cannot point across businesses (composite keys).
    const otherProfile = (
      await query(
        `SELECT id FROM "Customer" WHERE "tenantId" = $1 AND "externalSubject" = 'existing-sub'`,
        [SECOND_TENANT],
      )
    ).rows[0].id;
    await expect(
      query(
        `INSERT INTO "CustomerLoyaltyAccount" (id, "tenantId", "customerId", balance, "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, 1, now())`,
        [TENANT_1_MOCHA_HOUSE_ID, otherProfile],
      ),
    ).rejects.toThrow();
  });

  it('the rollback refuses while any login holds profiles in more than one business', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    expect(await indexes(scratch.url)).toEqual([
      'Customer_tenantId_externalProvider_externalSubject_key',
    ]);
  });

  it('the rollback restores platform-wide uniqueness when every login has one profile', async () => {
    const clean = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4f2_rollback_clean',
    );
    try {
      await applyMigrations(clean.url, listMigrations(MIGRATIONS));
      await insertTenant(clean.url);
      await insertCustomer(clean.url, TENANT_1_MOCHA_HOUSE_ID, 'one');
      await insertCustomer(clean.url, SECOND_TENANT, 'two');
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      expect(await indexes(clean.url)).toEqual([
        'Customer_externalProvider_externalSubject_key',
      ]);
      await expect(
        insertCustomer(clean.url, SECOND_TENANT, 'one'),
      ).rejects.toThrow(/duplicate key/);
      // Data is untouched.
      const count = await withScratchClient(clean.url, (c) =>
        c.query<{ n: number }>(`SELECT count(*)::int AS n FROM "Customer"`),
      );
      expect(count.rows[0].n).toBe(2);
    } finally {
      await clean.drop();
    }
  });
});
