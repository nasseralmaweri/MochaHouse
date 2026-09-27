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

// Milestone S0D-2A — the guarded re-backfill + NOT NULL migration for the
// locations / catalog / pricing / store-operations slice, exercised ONLY on
// throwaway scratch databases, starting from the exact post-S0D-1 state with
// rows created during the "nullable window" (tenantId NULL).

jest.setTimeout(180_000);

const repoRoot = join(__dirname, '../../../..');
const migrations = listMigrations(
  join(repoRoot, 'packages/database/prisma/migrations'),
);
const targetIndex = migrations.findIndex((m) =>
  m.name.endsWith('_require_tenant_id_catalog_operations'),
);
const before = migrations.slice(0, targetIndex);
const target = migrations[targetIndex];

const SLICE = [
  'Category',
  'ChecklistInstance',
  'ChecklistInstanceItem',
  'ChecklistTemplate',
  'ChecklistTemplateItem',
  'Location',
  'LocationMenu',
  'LocationProductAvailabilityOverride',
  'LocationProductPriceOverride',
  'Menu',
  'MenuProduct',
  'ModifierGroup',
  'ModifierOption',
  'OperationsTask',
  'Product',
  'ProductModifierGroup',
];
const tenantTables = Object.entries(MODEL_TENANCY)
  .filter(([, tenancy]) => tenancy === 'tenant')
  .map(([model]) => model);

const baseUrl = process.env.DATABASE_URL!;

// Rows written during the nullable window: every slice table gets one row
// with NO tenantId, plus a tenantless Customer and InternalUser — tables
// OUTSIDE this slice, which must be left exactly as they are.
const WINDOW_ROWS_SQL = `
INSERT INTO "Location" (id, name, slug, "updatedAt") VALUES ('loc-w', 'Window', 'window', now());
INSERT INTO "Category" (id, name, slug, "updatedAt") VALUES ('cat-w', 'Coffee', 'coffee-w', now());
INSERT INTO "Product" (id, name, slug, "categoryId", "updatedAt") VALUES ('prod-w', 'Drip', 'drip-w', 'cat-w', now());
INSERT INTO "Menu" (id, name, slug, "updatedAt") VALUES ('menu-w', 'Main', 'main-w', now());
INSERT INTO "MenuProduct" ("menuId", "productId") VALUES ('menu-w', 'prod-w');
INSERT INTO "LocationMenu" ("locationId", "menuId") VALUES ('loc-w', 'menu-w');
INSERT INTO "ModifierGroup" (id, name, "updatedAt") VALUES ('mg-w', 'Size', now());
INSERT INTO "ModifierOption" (id, name, "modifierGroupId", "updatedAt") VALUES ('mo-w', 'Small', 'mg-w', now());
INSERT INTO "ProductModifierGroup" ("productId", "modifierGroupId") VALUES ('prod-w', 'mg-w');
INSERT INTO "LocationProductPriceOverride" ("locationId", "menuId", "productId", price, "updatedAt")
  VALUES ('loc-w', 'menu-w', 'prod-w', 300, now());
INSERT INTO "LocationProductAvailabilityOverride" ("locationId", "menuId", "productId", "isAvailable", "updatedAt")
  VALUES ('loc-w', 'menu-w', 'prod-w', true, now());
INSERT INTO "ChecklistTemplate" (id, key, name, "updatedAt") VALUES ('tpl-w', 'opening', 'Opening', now());
INSERT INTO "ChecklistTemplateItem" (id, "templateId", section, label, "sortOrder", "updatedAt")
  VALUES ('tpi-w', 'tpl-w', 'Open', 'Unlock', 1, now());
INSERT INTO "ChecklistInstance" (id, "templateId", "locationId", "businessDate", "updatedAt")
  VALUES ('ci-w', 'tpl-w', 'loc-w', '2026-09-26', now());
INSERT INTO "ChecklistInstanceItem" (id, "checklistInstanceId", section, label, "sortOrder")
  VALUES ('cii-w', 'ci-w', 'Open', 'Unlock', 1);
INSERT INTO "InternalUser" (id, "externalProvider", email, "updatedAt") VALUES ('iu-w', 'internal-dev', 'w@example.com', now());
INSERT INTO "OperationsTask" (id, "locationId", "businessDate", title, "createdByInternalUserId", "updatedAt")
  VALUES ('task-w', 'loc-w', '2026-09-26', 'Task', 'iu-w', now());
INSERT INTO "Customer" (id, "externalProvider", "externalSubject", "updatedAt") VALUES ('cust-w', 'dev', 'dev:w', now());
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
    return Object.fromEntries(
      rows.map((row) => [row.table_name, row.is_nullable]),
    );
  });
}

async function tenantIds(
  url: string,
  table: string,
): Promise<(string | null)[]> {
  return withScratchClient(url, async (client) => {
    const { rows } = await client.query<{ tenantId: string | null }>(
      `SELECT "tenantId" FROM "${table}"`,
    );
    return rows.map((row) => row.tenantId);
  });
}

describe('S0D-2A NOT NULL migration — catalog & store operations (scratch databases)', () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await createScratchDatabase(baseUrl, 's0d2a');
    await applyMigrations(scratch.url, before);
    await applyMigrationSql(scratch.url, WINDOW_ROWS_SQL);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('follows S0D-1 and is applied by Prisma as ONE atomic unit', () => {
    expect(targetIndex).toBeGreaterThan(0);
    expect(before.some((m) => m.name.endsWith('_add_tenant_id_columns'))).toBe(
      true,
    );
    expect(isAppliedAtomically(target.sql)).toBe(true);
  });

  it('touches exactly the 16 slice tables, with guards before the backfill and the backfill before NOT NULL', () => {
    const altered = [
      ...target.sql.matchAll(
        /ALTER TABLE "(\w+)" ALTER COLUMN "tenantId" SET NOT NULL;/g,
      ),
    ]
      .map((m) => m[1])
      .sort();
    expect(altered).toEqual(SLICE);
    expect(target.sql).not.toMatch(
      /ADD VALUE|DEFAULT|UNIQUE|FOREIGN KEY|TRIGGER|CREATE INDEX|DROP /,
    );

    const at = (needle: string) => target.sql.indexOf(needle);
    expect(at('other than Tenant #1')).toBeLessThan(at('UPDATE %I SET'));
    expect(at('not ACTIVE')).toBeLessThan(at('UPDATE %I SET'));
    expect(at('UPDATE %I SET')).toBeLessThan(
      at('ALTER TABLE "Category" ALTER COLUMN'),
    );
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
        /S0D-2A aborted: 1 tenant\(s\) other than Tenant #1 exist/,
      );
      const columns = await nullability(scratch.url);
      for (const table of SLICE) {
        expect({ table, nullable: columns[table] }).toEqual({
          table,
          nullable: 'YES',
        });
      }
      expect(await tenantIds(scratch.url, 'Location')).toEqual([null]);
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
        /S0D-2A aborted: Tenant #1 is SUSPENDED/,
      );
      expect((await nullability(scratch.url)).Location).toBe('YES');
    } finally {
      await withScratchClient(scratch.url, (client) =>
        client.query(
          `UPDATE "Tenant" SET status = 'ACTIVE', "suspensionReason" = NULL WHERE id = $1`,
          [TENANT_1_MOCHA_HOUSE_ID],
        ),
      );
    }
  });

  it('when every guard passes: backfills window rows to Tenant #1, sets NOT NULL on the slice only, and leaves other tables untouched', async () => {
    await applyMigrationSql(scratch.url, target.sql);

    for (const table of SLICE) {
      const ids = await tenantIds(scratch.url, table);
      expect({ table, ids }).toEqual({ table, ids: [TENANT_1_MOCHA_HOUSE_ID] });
    }

    const columns = await nullability(scratch.url);
    for (const table of tenantTables) {
      expect({ table, nullable: columns[table] }).toEqual({
        table,
        nullable: SLICE.includes(table) ? 'NO' : 'YES',
      });
    }
    // Tables outside the slice keep their NULL window rows untouched.
    expect(await tenantIds(scratch.url, 'Customer')).toEqual([null]);
    expect(await tenantIds(scratch.url, 'InternalUser')).toEqual([null]);
  });

  it('afterwards the database refuses a tenantless row in a converted table', async () => {
    await expect(
      applyMigrationSql(
        scratch.url,
        `INSERT INTO "Menu" (id, name, slug, "updatedAt") VALUES ('menu-x', 'X', 'x', now())`,
      ),
    ).rejects.toThrow(/null value in column "tenantId"/);
  });
});
