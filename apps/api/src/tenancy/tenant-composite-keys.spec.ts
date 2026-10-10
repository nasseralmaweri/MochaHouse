import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TENANT_1_MOCHA_HOUSE_ID,
  TENANT_RELATIONSHIPS,
  checkTenantIntegrity,
} from '@mocha-house/database';
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

// Security 4C-2 — composite tenant keys.
//
// Every table another business-owned table references (the target of a
// composite foreign-key candidate in the relationship inventory) carries a
// UNIQUE ("tenantId", "id") index, so Security 4C-3 can add composite
// foreign keys. This spec proves:
//   - schema.prisma, the migration and the rollback name exactly that set;
//   - the configured (migrated) test database has every key — a future
//     migration cannot silently drop one;
//   - on a scratch database with fictional data the migration only ADDS
//     those 25 indexes: no data, key, constraint or foreign key changes,
//     same-business writes keep working, cross-business links stay
//     detectable, composite foreign keys become possible, and the rollback
//     restores the previous catalog exactly.

jest.setTimeout(300_000);

const repoRoot = join(__dirname, '../../../..');
const schema = readFileSync(
  join(repoRoot, 'packages/database/prisma/schema.prisma'),
  'utf8',
);
const MIGRATION = '20261011090000_tenant_composite_keys';
const migrations = listMigrations(
  join(repoRoot, 'packages/database/prisma/migrations'),
);
const targetIndex = migrations.findIndex((m) => m.name === MIGRATION);
const target = migrations[targetIndex];
const rollbackSql = readFileSync(
  join(repoRoot, `packages/database/prisma/rollbacks/${MIGRATION}.down.sql`),
  'utf8',
);
const baseUrl = process.env.DATABASE_URL!;
const A = TENANT_1_MOCHA_HOUSE_ID;
const B = TEST_TENANT_B_ID;

// The parents: every table a composite foreign-key candidate points at.
const PARENTS = [
  ...new Set(
    TENANT_RELATIONSHIPS.filter((r) => r.kind === 'composite-fk-candidate').map(
      (r) => (r as { target: string }).target,
    ),
  ),
].sort();

const statements = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

async function query<T extends object>(url: string, sql: string) {
  return withScratchClient(url, async (client) => {
    const { rows } = await client.query<T>(sql);
    return rows;
  });
}

// Tables (sorted) that have a valid, non-partial UNIQUE index on exactly
// ("tenantId", "id"), in that order.
async function tablesWithCompositeKey(url: string): Promise<string[]> {
  const rows = await query<{ table: string }>(
    url,
    `SELECT DISTINCT t.relname AS table
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND i.indisunique AND i.indisvalid
        AND i.indpred IS NULL AND i.indnkeyatts = 2
        AND (SELECT array_agg(a.attname ORDER BY k.ord)
               FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum)
            = ARRAY['tenantId', 'id']::name[]
      ORDER BY 1`,
  );
  return rows.map((r) => r.table);
}

// Every index and constraint definition in the public schema.
async function catalog(url: string) {
  const indexes = await query<{ d: string }>(
    url,
    `SELECT indexdef AS d FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
  );
  const constraints = await query<{ d: string }>(
    url,
    `SELECT c.conrelid::regclass::text || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid) AS d
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' ORDER BY 1`,
  );
  return {
    indexes: indexes.map((r) => r.d),
    constraints: constraints.map((r) => r.d),
  };
}

// A checksum of every row of every table (excluding Prisma's own history).
async function dataChecksum(url: string): Promise<string> {
  return withScratchClient(url, async (client) => {
    const { rows: tables } = await client.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1`,
    );
    const parts: string[] = [];
    for (const { name } of tables) {
      const { rows } = await client.query<{ sum: string }>(
        `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS sum FROM "${name}" t`,
      );
      parts.push(`${name}:${rows[0].sum}`);
    }
    return parts.join(',');
  });
}

// Fictional two-business data in the parent tables the fixture touches.
const FIXTURE = `
  INSERT INTO "Tenant"(id, slug, name, status, "updatedAt")
    VALUES ('${B}', 'test-tenant-b', 'Test Tenant B', 'ACTIVE', now());
  INSERT INTO "Location"(id, "tenantId", name, slug, "updatedAt") VALUES
    ('ck-loc-a', '${A}', 'A Store', 'ck-a-store', now()),
    ('ck-loc-b', '${B}', 'B Store', 'ck-b-store', now());
  INSERT INTO "Category"(id, "tenantId", name, slug, "updatedAt") VALUES
    ('ck-cat-a', '${A}', 'A Drinks', 'ck-a-drinks', now());
  INSERT INTO "Product"(id, "tenantId", name, slug, "categoryId", "updatedAt") VALUES
    ('ck-prod-a', '${A}', 'A Latte', 'ck-a-latte', 'ck-cat-a', now());
  INSERT INTO "Customer"(id, "tenantId", "externalProvider", "externalSubject", "updatedAt") VALUES
    ('ck-cust-a', '${A}', 'dev', 'ck-subject-a', now());
  INSERT INTO "PaymentAttempt"(id, "tenantId", "idempotencyKey", provider, amount, currency, "locationId", "updatedAt") VALUES
    ('ck-pay-a', '${A}', 'ck-idem-a', 'fake', 500, 'USD', 'ck-loc-a', now());
  INSERT INTO "Order"(id, "tenantId", "orderNumber", "accessToken", "locationId", "customerId",
                      "paymentAttemptId", "guestName", "guestPhone", currency, subtotal, "updatedAt") VALUES
    ('ck-order-a', '${A}', 'CK-1', 'ck-token-a', 'ck-loc-a', 'ck-cust-a', 'ck-pay-a',
     'Fictional Guest', '5550000000', 'USD', 500, now());
`;

describe('Composite tenant keys (Security 4C-2)', () => {
  it('derives exactly 25 parent tables from the relationship inventory', () => {
    expect(PARENTS).toHaveLength(25);
  });

  it('schema.prisma declares @@unique([tenantId, id]) on exactly those parents', () => {
    const declared = [...schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)]
      .filter((m) => /@@unique\(\[tenantId, id\]\)/.test(m[2]))
      .map((m) => m[1])
      .sort();
    expect(declared).toEqual(PARENTS);
  });

  it('the migration only creates those 25 unique indexes, atomically', () => {
    expect(targetIndex).toBe(migrations.length - 1);
    expect(isAppliedAtomically(target.sql)).toBe(true);
    expect(statements(target.sql)).toEqual(
      PARENTS.map(
        (t) =>
          `CREATE UNIQUE INDEX "${t}_tenantId_id_key" ON "${t}"("tenantId", "id")`,
      ),
    );
  });

  it('the rollback only drops those 25 indexes', () => {
    expect(statements(rollbackSql)).toEqual(
      PARENTS.map((t) => `DROP INDEX IF EXISTS "${t}_tenantId_id_key"`),
    );
  });

  it('the migrated test database carries every composite key (catalog regression guard)', async () => {
    const present = await tablesWithCompositeKey(baseUrl);
    expect(PARENTS.filter((t) => !present.includes(t))).toEqual([]);
  });

  describe('on a scratch database with fictional data', () => {
    let scratch: ScratchDatabase;
    let before: Awaited<ReturnType<typeof catalog>>;
    let beforeData: string;

    beforeAll(async () => {
      scratch = await createScratchDatabase(baseUrl, 'composite_keys');
      await applyMigrations(scratch.url, migrations.slice(0, targetIndex));
      await applyMigrationSql(scratch.url, FIXTURE);
      before = await catalog(scratch.url);
      beforeData = await dataChecksum(scratch.url);
    });
    afterAll(async () => {
      await scratch?.drop();
    });

    it('before the migration, a composite foreign key is impossible', async () => {
      await expect(
        withScratchClient(scratch.url, (client) =>
          client.query(
            `ALTER TABLE "Order" ADD CONSTRAINT probe FOREIGN KEY ("tenantId", "locationId")
               REFERENCES "Location"("tenantId", "id") NOT VALID`,
          ),
        ),
      ).rejects.toThrow(/no unique constraint matching given keys/);
      expect(await tablesWithCompositeKey(scratch.url)).toEqual([]);
    });

    it('applies, adds exactly the 25 keys and changes nothing else — no data, key, constraint or foreign key', async () => {
      await applyMigrationSql(scratch.url, target.sql);
      expect(await tablesWithCompositeKey(scratch.url)).toEqual(PARENTS);
      const after = await catalog(scratch.url);
      const added = after.indexes.filter((d) => !before.indexes.includes(d));
      expect(after.indexes.filter((d) => before.indexes.includes(d))).toEqual(
        before.indexes,
      );
      expect(added.sort()).toEqual(
        PARENTS.map(
          (t) =>
            `CREATE UNIQUE INDEX "${t}_tenantId_id_key" ON public."${t}" USING btree ("tenantId", id)`,
        ).sort(),
      );
      // Primary keys, unique constraints, foreign keys and checks: identical.
      expect(after.constraints).toEqual(before.constraints);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('same-business writes keep working after the migration', async () => {
      await withScratchClient(scratch.url, async (client) => {
        await client.query('BEGIN');
        try {
          await client.query(
            `INSERT INTO "Location"(id, "tenantId", name, slug, "updatedAt")
               VALUES ('ck-loc-a2', '${A}', 'A Store 2', 'ck-a-store-2', now())`,
          );
          await client.query(
            `UPDATE "Order" SET "locationId" = 'ck-loc-a2' WHERE id = 'ck-order-a'`,
          );
          const { rows } = await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM "Order" o JOIN "Location" l
               ON l."tenantId" = o."tenantId" AND l.id = o."locationId"`,
          );
          expect(rows[0].n).toBe(1);
        } finally {
          await client.query('ROLLBACK');
        }
      });
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('a composite foreign key can now reference (tenantId, id) — proven in a rolled-back transaction', async () => {
      await withScratchClient(scratch.url, async (client) => {
        await client.query('BEGIN');
        try {
          await client.query(
            `ALTER TABLE "Order" ADD CONSTRAINT probe FOREIGN KEY ("tenantId", "locationId")
               REFERENCES "Location"("tenantId", "id")`,
          );
          await expect(
            client.query(
              `UPDATE "Order" SET "locationId" = 'ck-loc-b' WHERE id = 'ck-order-a'`,
            ),
          ).rejects.toThrow(/violates foreign key constraint "probe"/);
        } finally {
          await client.query('ROLLBACK');
        }
      });
      expect((await catalog(scratch.url)).constraints).toEqual(
        before.constraints,
      );
    });

    it('cross-business links stay detectable by the integrity checker (single-column keys still allow them until 4C-3)', async () => {
      const relink = (location: string) =>
        query(
          scratch.url,
          `UPDATE "Order" SET "locationId" = '${location}' WHERE id = 'ck-order-a'`,
        );
      await relink('ck-loc-b');
      try {
        const report = await withScratchClient(scratch.url, (client) =>
          checkTenantIntegrity(client, { sampleLimit: 1 }),
        );
        expect(
          report.findings.map(
            (f) => `${f.severity} ${f.relationshipId} ${f.type}`,
          ),
        ).toEqual(['violation Order.locationId cross-tenant']);
        expect(report.verdict).toBe('violations');
      } finally {
        await relink('ck-loc-a');
      }
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });

    it('the rollback restores the previous catalog exactly, and the migration re-applies cleanly', async () => {
      await applyMigrationSql(scratch.url, rollbackSql);
      expect(await catalog(scratch.url)).toEqual(before);
      expect(await tablesWithCompositeKey(scratch.url)).toEqual([]);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
      await applyMigrationSql(scratch.url, target.sql);
      expect(await tablesWithCompositeKey(scratch.url)).toEqual(PARENTS);
      expect(await dataChecksum(scratch.url)).toBe(beforeData);
    });
  });
});
