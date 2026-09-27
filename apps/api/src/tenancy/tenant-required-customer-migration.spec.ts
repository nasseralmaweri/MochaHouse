import 'dotenv/config';
import { join } from 'node:path';
import { MODEL_TENANCY, TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  isAppliedAtomically,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';

// Milestone S0D-2B-1 — the guarded re-backfill + NOT NULL migration for
// Customer ONLY, exercised on throwaway scratch databases starting from the
// exact post-S0D-2A state with a Customer created in the nullable window.

jest.setTimeout(180_000);

const repoRoot = join(__dirname, '../../../..');
const migrations = listMigrations(
  join(repoRoot, 'packages/database/prisma/migrations'),
);
const targetIndex = migrations.findIndex((m) =>
  m.name.endsWith('_require_tenant_id_customer'),
);
const before = migrations.slice(0, targetIndex);
const target = migrations[targetIndex];

// Models already NOT NULL before this migration (S0D-2A) plus Customer.
const REQUIRED_AFTER = new Set([
  'Location',
  'Category',
  'Product',
  'Menu',
  'ModifierGroup',
  'ModifierOption',
  'ProductModifierGroup',
  'MenuProduct',
  'LocationMenu',
  'LocationProductPriceOverride',
  'LocationProductAvailabilityOverride',
  'ChecklistTemplate',
  'ChecklistTemplateItem',
  'ChecklistInstance',
  'ChecklistInstanceItem',
  'OperationsTask',
  'Customer',
]);
const tenantTables = Object.entries(MODEL_TENANCY)
  .filter(([, tenancy]) => tenancy === 'tenant')
  .map(([model]) => model);

const baseUrl = process.env.DATABASE_URL!;

// Window rows: a tenantless Customer, plus tenantless rows in its two
// S0D-2B-2 children, which this migration must leave exactly as they are.
const WINDOW_ROWS_SQL = `
INSERT INTO "Location" (id, name, slug, "updatedAt", "tenantId")
  VALUES ('loc-w', 'Window', 'window', now(), '${TENANT_1_MOCHA_HOUSE_ID}');
INSERT INTO "Customer" (id, "externalProvider", "externalSubject", "updatedAt")
  VALUES ('cust-w', 'dev', 'dev:window', now());
INSERT INTO "InternalUser" (id, "externalProvider", email, "updatedAt")
  VALUES ('iu-w', 'internal-dev', 'w@example.com', now());
INSERT INTO "CustomerPreferredLocation" (id, "customerId", "locationId")
  VALUES ('cpl-w', 'cust-w', 'loc-w');
INSERT INTO "CustomerNote" (id, "customerId", "authorInternalUserId", body)
  VALUES ('note-w', 'cust-w', 'iu-w', 'note');
`;

async function nullability(url: string): Promise<Record<string, string>> {
  return withScratchClient(url, async (client) => {
    const { rows } = await client.query<{
      table_name: string;
      is_nullable: string;
    }>(
      `SELECT table_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'tenantId'`,
    );
    return Object.fromEntries(rows.map((r) => [r.table_name, r.is_nullable]));
  });
}

async function tenantIds(url: string, table: string) {
  return withScratchClient(url, async (client) => {
    const { rows } = await client.query<{ tenantId: string | null }>(
      `SELECT "tenantId" FROM "${table}"`,
    );
    return rows.map((row) => row.tenantId);
  });
}

describe('S0D-2B-1 Customer NOT NULL migration (scratch databases)', () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await createScratchDatabase(baseUrl, 's0d2b1');
    await applyMigrations(scratch.url, before);
    await applyMigrationSql(scratch.url, WINDOW_ROWS_SQL);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('follows S0D-2A, is atomic, and alters ONLY Customer (guards before backfill before NOT NULL)', () => {
    expect(targetIndex).toBeGreaterThan(0);
    expect(
      before.some((m) =>
        m.name.endsWith('_require_tenant_id_catalog_operations'),
      ),
    ).toBe(true);
    expect(isAppliedAtomically(target.sql)).toBe(true);

    const altered = [
      ...target.sql.matchAll(
        /ALTER TABLE "(\w+)" ALTER COLUMN "tenantId" SET NOT NULL;/g,
      ),
    ].map((m) => m[1]);
    expect(altered).toEqual(['Customer']);
    expect(target.sql).not.toMatch(
      /ADD VALUE|DEFAULT|UNIQUE|FOREIGN KEY|TRIGGER|CREATE INDEX|DROP /,
    );

    const at = (needle: string) => target.sql.indexOf(needle);
    expect(at('other than Tenant #1')).toBeLessThan(at('UPDATE "Customer"'));
    expect(at('not ACTIVE')).toBeLessThan(at('UPDATE "Customer"'));
    expect(at('UPDATE "Customer"')).toBeLessThan(at('ALTER TABLE "Customer"'));
  });

  it('aborts, rolling everything back, when another tenant exists', async () => {
    await withScratchClient(scratch.url, (client) =>
      client.query(
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'test-tenant-b', 'B', 'ACTIVE', now())`,
        [TEST_TENANT_B_ID],
      ),
    );
    try {
      await expect(applyMigrationSql(scratch.url, target.sql)).rejects.toThrow(
        /S0D-2B-1 aborted: 1 tenant\(s\) other than Tenant #1 exist/,
      );
      expect((await nullability(scratch.url)).Customer).toBe('YES');
      expect(await tenantIds(scratch.url, 'Customer')).toEqual([null]);
    } finally {
      await withScratchClient(scratch.url, (client) =>
        client.query(`DELETE FROM "Tenant" WHERE id = $1`, [TEST_TENANT_B_ID]),
      );
    }
  });

  it('aborts when Tenant #1 is not ACTIVE', async () => {
    await withScratchClient(scratch.url, (client) =>
      client.query(
        `UPDATE "Tenant" SET status = 'SUSPENDED', "suspensionReason" = 'SECURITY' WHERE id = $1`,
        [TENANT_1_MOCHA_HOUSE_ID],
      ),
    );
    try {
      await expect(applyMigrationSql(scratch.url, target.sql)).rejects.toThrow(
        /S0D-2B-1 aborted: Tenant #1 is SUSPENDED/,
      );
      expect((await nullability(scratch.url)).Customer).toBe('YES');
    } finally {
      await withScratchClient(scratch.url, (client) =>
        client.query(
          `UPDATE "Tenant" SET status = 'ACTIVE', "suspensionReason" = NULL WHERE id = $1`,
          [TENANT_1_MOCHA_HOUSE_ID],
        ),
      );
    }
  });

  it('when guards pass: backfills the window Customer, makes ONLY Customer NOT NULL, and leaves its children nullable and untouched', async () => {
    await applyMigrationSql(scratch.url, target.sql);

    expect(await tenantIds(scratch.url, 'Customer')).toEqual([
      TENANT_1_MOCHA_HOUSE_ID,
    ]);
    const columns = await nullability(scratch.url);
    for (const table of tenantTables) {
      expect({ table, nullable: columns[table] }).toEqual({
        table,
        nullable: REQUIRED_AFTER.has(table) ? 'NO' : 'YES',
      });
    }
    expect(await tenantIds(scratch.url, 'CustomerPreferredLocation')).toEqual([
      null,
    ]);
    expect(await tenantIds(scratch.url, 'CustomerNote')).toEqual([null]);
  });

  it('afterwards refuses a tenantless Customer', async () => {
    await expect(
      applyMigrationSql(
        scratch.url,
        `INSERT INTO "Customer" (id, "externalProvider", "externalSubject", "updatedAt") VALUES ('c-x', 'dev', 'dev:x', now())`,
      ),
    ).rejects.toThrow(/null value in column "tenantId"/);
  });
});
