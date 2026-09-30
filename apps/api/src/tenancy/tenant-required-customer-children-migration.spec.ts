import 'dotenv/config';
import { join } from 'node:path';
import { MODEL_TENANCY, TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  TENANT_ID_REQUIRED_MODELS,
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  isAppliedAtomically,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';

// Milestone S0D-2B-2 — the guarded, parent-derived backfill + NOT NULL
// migration for CustomerPreferredLocation and CustomerNote ONLY, exercised
// on throwaway scratch databases starting from the exact post-S0D-2B-1
// state with child rows written in the nullable window.

jest.setTimeout(180_000);

const repoRoot = join(__dirname, '../../../..');
const migrations = listMigrations(
  join(repoRoot, 'packages/database/prisma/migrations'),
);
const targetIndex = migrations.findIndex((m) =>
  m.name.endsWith('_require_tenant_id_customer_children'),
);
const before = migrations.slice(0, targetIndex);
const target = migrations[targetIndex];

const CHILDREN = ['CustomerNote', 'CustomerPreferredLocation'];
// Models already NOT NULL before this migration (S0D-2A, S0D-2B-1) plus the
// two children.
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
  ...CHILDREN,
]);
const tenantTables = Object.entries(MODEL_TENANCY)
  .filter(([, tenancy]) => tenancy === 'tenant')
  .map(([model]) => model);

const baseUrl = process.env.DATABASE_URL!;

// Window rows: two Customers (Customer.tenantId is already required), a
// Location, and tenantless children for each Customer.
const WINDOW_ROWS_SQL = `
INSERT INTO "Location" (id, name, slug, "updatedAt", "tenantId")
  VALUES ('loc-w', 'Window', 'window', now(), '${TENANT_1_MOCHA_HOUSE_ID}');
INSERT INTO "Customer" (id, "externalProvider", "externalSubject", "updatedAt", "tenantId")
  VALUES ('cust-w1', 'dev', 'dev:window-1', now(), '${TENANT_1_MOCHA_HOUSE_ID}'),
         ('cust-w2', 'dev', 'dev:window-2', now(), '${TENANT_1_MOCHA_HOUSE_ID}');
INSERT INTO "InternalUser" (id, "externalProvider", email, "updatedAt")
  VALUES ('iu-w', 'internal-dev', 'w@example.com', now());
INSERT INTO "CustomerPreferredLocation" (id, "customerId", "locationId")
  VALUES ('cpl-w1', 'cust-w1', 'loc-w'), ('cpl-w2', 'cust-w2', 'loc-w');
INSERT INTO "CustomerNote" (id, "customerId", "authorInternalUserId", body)
  VALUES ('note-w1', 'cust-w1', 'iu-w', 'one'), ('note-w2', 'cust-w2', 'iu-w', 'two');
`;

async function query<T extends object>(
  url: string,
  sql: string,
  params: unknown[] = [],
) {
  return withScratchClient(url, async (client) => {
    const { rows } = await client.query<T>(sql, params);
    return rows;
  });
}

async function nullability(url: string): Promise<Record<string, string>> {
  const rows = await query<{ table_name: string; is_nullable: string }>(
    url,
    `SELECT table_name, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'tenantId'`,
  );
  return Object.fromEntries(rows.map((r) => [r.table_name, r.is_nullable]));
}

async function tenantIds(url: string, table: string) {
  const rows = await query<{ tenantId: string | null }>(
    url,
    `SELECT "tenantId" FROM "${table}" ORDER BY id`,
  );
  return rows.map((row) => row.tenantId);
}

// Everything the migration must NOT change: constraints, indexes, triggers
// and column defaults on every tenant table, plus the enum catalogue.
async function structure(url: string) {
  const constraints = await query<{ def: string }>(
    url,
    `SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1`,
  );
  const indexes = await query<{ def: string }>(
    url,
    `SELECT indexdef AS def FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
  );
  const triggers = await query<{ def: string }>(
    url,
    `SELECT tgrelid::regclass::text || ' ' || tgname AS def
       FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`,
  );
  const defaults = await query<{ def: string }>(
    url,
    `SELECT table_name || '.' || column_name || '=' || column_default AS def
       FROM information_schema.columns
      WHERE table_schema = 'public' AND column_default IS NOT NULL ORDER BY 1`,
  );
  const enums = await query<{ def: string }>(
    url,
    `SELECT t.typname || '.' || e.enumlabel AS def
       FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid ORDER BY 1`,
  );
  const pick = (rows: { def: string }[]) => rows.map((r) => r.def);
  return {
    constraints: pick(constraints),
    indexes: pick(indexes),
    triggers: pick(triggers),
    defaults: pick(defaults),
    enums: pick(enums),
  };
}

// Plants a row state that the application and the FKs would never allow,
// by skipping FK enforcement for ONE statement batch on the scratch
// database only. Used to prove the post-backfill consistency checks fire.
async function withoutFkChecks(url: string, sql: string) {
  await applyMigrationSql(
    url,
    `SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`,
  );
}

describe('S0D-2B-2 customer children NOT NULL migration (scratch databases)', () => {
  let scratch: ScratchDatabase;
  let structureBefore: Awaited<ReturnType<typeof structure>>;

  beforeAll(async () => {
    scratch = await createScratchDatabase(baseUrl, 's0d2b2');
    await applyMigrations(scratch.url, before);
    await applyMigrationSql(scratch.url, WINDOW_ROWS_SQL);
    structureBefore = await structure(scratch.url);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('follows S0D-2B-1, is atomic, alters ONLY the two children, and orders guards → backfill → checks → NOT NULL', () => {
    expect(targetIndex).toBeGreaterThan(0);
    expect(before[before.length - 1].name).toMatch(
      /_require_tenant_id_customer$/,
    );
    expect(isAppliedAtomically(target.sql)).toBe(true);

    const altered = [
      ...target.sql.matchAll(
        /ALTER TABLE "(\w+)" ALTER COLUMN "tenantId" SET NOT NULL;/g,
      ),
    ].map((m) => m[1]);
    expect(altered.sort()).toEqual(CHILDREN);
    expect(target.sql).not.toMatch(
      /ADD VALUE|CREATE TYPE|DEFAULT|UNIQUE|FOREIGN KEY|TRIGGER|CREATE INDEX|DROP /,
    );
    // Backfill is parent-derived, never a blanket Tenant #1 assignment.
    expect(target.sql).not.toMatch(/SET "tenantId" = tenant_one/);

    const at = (needle: string) => target.sql.indexOf(needle);
    const firstUpdate = at('UPDATE "CustomerPreferredLocation"');
    expect(at('not ACTIVE')).toBeLessThan(firstUpdate);
    expect(at('other than Tenant #1')).toBeLessThan(firstUpdate);
    expect(firstUpdate).toBeLessThan(at('UPDATE "CustomerNote"'));
    const lastCheck = at('join a Customer and a Location of different tenants');
    expect(at('UPDATE "CustomerNote"')).toBeLessThan(lastCheck);
    expect(lastCheck).toBeLessThan(at('ALTER TABLE "CustomerNote"'));
    expect(lastCheck).toBeLessThan(
      at('ALTER TABLE "CustomerPreferredLocation"'),
    );
  });

  it('aborts, rolling everything back, when another tenant exists', async () => {
    await query(
      scratch.url,
      `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'test-tenant-b', 'B', 'ACTIVE', now())`,
      [TEST_TENANT_B_ID],
    );
    try {
      await expect(applyMigrationSql(scratch.url, target.sql)).rejects.toThrow(
        /S0D-2B-2 aborted: 1 tenant\(s\) other than Tenant #1 exist/,
      );
      const columns = await nullability(scratch.url);
      for (const table of CHILDREN) {
        expect(columns[table]).toBe('YES');
        expect(await tenantIds(scratch.url, table)).toEqual([null, null]);
      }
    } finally {
      await query(scratch.url, `DELETE FROM "Tenant" WHERE id = $1`, [
        TEST_TENANT_B_ID,
      ]);
    }
  });

  it('aborts when Tenant #1 is not ACTIVE', async () => {
    await query(
      scratch.url,
      `UPDATE "Tenant" SET status = 'SUSPENDED', "suspensionReason" = 'SECURITY' WHERE id = $1`,
      [TENANT_1_MOCHA_HOUSE_ID],
    );
    try {
      await expect(applyMigrationSql(scratch.url, target.sql)).rejects.toThrow(
        /S0D-2B-2 aborted: Tenant #1 is SUSPENDED/,
      );
      const columns = await nullability(scratch.url);
      for (const table of CHILDREN) {
        expect(columns[table]).toBe('YES');
        expect(await tenantIds(scratch.url, table)).toEqual([null, null]);
      }
    } finally {
      await query(
        scratch.url,
        `UPDATE "Tenant" SET status = 'ACTIVE', "suspensionReason" = NULL WHERE id = $1`,
        [TENANT_1_MOCHA_HOUSE_ID],
      );
    }
  });

  it('aborts when a preferred location would join a Customer and a Location of different tenants', async () => {
    await withoutFkChecks(
      scratch.url,
      `UPDATE "Location" SET "tenantId" = 'ghost-tenant' WHERE id = 'loc-w';`,
    );
    try {
      await expect(applyMigrationSql(scratch.url, target.sql)).rejects.toThrow(
        /S0D-2B-2 aborted: 2 CustomerPreferredLocation row\(s\) join a Customer and a Location of different tenants/,
      );
      const columns = await nullability(scratch.url);
      for (const table of CHILDREN) {
        expect(columns[table]).toBe('YES');
        expect(await tenantIds(scratch.url, table)).toEqual([null, null]);
      }
    } finally {
      await query(
        scratch.url,
        `UPDATE "Location" SET "tenantId" = $1 WHERE id = 'loc-w'`,
        [TENANT_1_MOCHA_HOUSE_ID],
      );
    }
  });

  it("aborts when an already-set child tenant does not match its Customer's tenant", async () => {
    await withoutFkChecks(
      scratch.url,
      `UPDATE "CustomerNote" SET "tenantId" = 'ghost-tenant' WHERE id = 'note-w2';`,
    );
    try {
      await expect(applyMigrationSql(scratch.url, target.sql)).rejects.toThrow(
        /S0D-2B-2 aborted: 1 CustomerNote row\(s\) do not match their Customer's tenant/,
      );
      expect((await nullability(scratch.url)).CustomerNote).toBe('YES');
      expect(await tenantIds(scratch.url, 'CustomerNote')).toEqual([
        null,
        'ghost-tenant',
      ]);
    } finally {
      await query(
        scratch.url,
        `UPDATE "CustomerNote" SET "tenantId" = NULL WHERE id = 'note-w2'`,
      );
    }
  });

  it('when guards and checks pass: backfills from the parent Customer and makes ONLY the two children NOT NULL, changing nothing else', async () => {
    await applyMigrationSql(scratch.url, target.sql);

    for (const table of CHILDREN) {
      expect(await tenantIds(scratch.url, table)).toEqual([
        TENANT_1_MOCHA_HOUSE_ID,
        TENANT_1_MOCHA_HOUSE_ID,
      ]);
    }
    const mismatched = await query<{ n: string }>(
      scratch.url,
      `SELECT (
         (SELECT COUNT(*) FROM "CustomerPreferredLocation" x JOIN "Customer" c ON c.id = x."customerId" WHERE x."tenantId" <> c."tenantId")
       + (SELECT COUNT(*) FROM "CustomerNote" x JOIN "Customer" c ON c.id = x."customerId" WHERE x."tenantId" <> c."tenantId")
       )::text AS n`,
    );
    expect(mismatched[0].n).toBe('0');

    const columns = await nullability(scratch.url);
    for (const table of tenantTables) {
      expect({ table, nullable: columns[table] }).toEqual({
        table,
        nullable: REQUIRED_AFTER.has(table) ? 'NO' : 'YES',
      });
    }
    // 19 required / 44 still nullable at this point in the conversion.
    expect(tenantTables.filter((t) => columns[t] === 'NO')).toHaveLength(19);
    expect(tenantTables.filter((t) => columns[t] === 'YES')).toHaveLength(44);
    // Every model this slice made required stays in the testing package's
    // running list (later slices only ever extend it).
    expect(TENANT_ID_REQUIRED_MODELS).toEqual(
      expect.arrayContaining([...REQUIRED_AFTER]),
    );

    // No default, and no constraint / index / trigger / enum change.
    expect(await structure(scratch.url)).toEqual(structureBefore);
  });

  it('afterwards refuses tenantless children', async () => {
    await expect(
      applyMigrationSql(
        scratch.url,
        `INSERT INTO "Location" (id, name, slug, "updatedAt", "tenantId") VALUES ('loc-x', 'X', 'x', now(), '${TENANT_1_MOCHA_HOUSE_ID}');
         INSERT INTO "CustomerPreferredLocation" (id, "customerId", "locationId") VALUES ('cpl-x', 'cust-w1', 'loc-x')`,
      ),
    ).rejects.toThrow(/null value in column "tenantId"/);
    await expect(
      applyMigrationSql(
        scratch.url,
        `INSERT INTO "CustomerNote" (id, "customerId", "authorInternalUserId", body) VALUES ('note-x', 'cust-w1', 'iu-w', 'x')`,
      ),
    ).rejects.toThrow(/null value in column "tenantId"/);
  });
});
