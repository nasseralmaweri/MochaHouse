import 'dotenv/config';
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
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

// The statements inside the file's single DO block — null unless the file
// (comments aside) is exactly one `DO $tag$ BEGIN ... END $tag$;` block.
function doBlockStatements(sql: string, tag: string): string[] | null {
  const code = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .trim();
  const match = new RegExp(
    `^DO \\$${tag}\\$\\s*BEGIN([\\s\\S]*)END\\s*\\$${tag}\\$;$`,
  ).exec(code);
  return match
    ? match[1]
        .split(';')
        .map((s) => s.trim().replace(/\s+/g, ' '))
        .filter(Boolean)
    : null;
}

// The pre-4C-2 schema: the same file without the 25 composite keys (and
// their three comment lines).
const KEY_LINES = new Set([
  '  // Security 4C-2 — composite tenant key: lets child tables reference',
  '  // (tenantId, id) so the database itself can refuse a cross-business link',
  '  // (composite foreign keys arrive in Security 4C-3).',
  '  @@unique([tenantId, id])',
]);
const schemaWithoutKeys = schema
  .split('\n')
  .filter((line) => !KEY_LINES.has(line))
  .join('\n');

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

  it('the migration is ONE DO block that only sets a local lock_timeout and creates those 25 indexes', () => {
    expect(targetIndex).toBe(migrations.length - 1);
    // A dollar-quoted file is the only shape Prisma sends as one statement.
    expect(isAppliedAtomically(target.sql)).toBe(true);
    expect(doBlockStatements(target.sql, 'tenant_composite_keys')).toEqual([
      "PERFORM set_config('lock_timeout', '5s', true)",
      ...PARENTS.map(
        (t) =>
          `CREATE UNIQUE INDEX "${t}_tenantId_id_key" ON "${t}"("tenantId", "id")`,
      ),
    ]);
  });

  it('the rollback is ONE DO block that only drops those 25 indexes', () => {
    expect(isAppliedAtomically(rollbackSql)).toBe(true);
    expect(
      doBlockStatements(rollbackSql, 'tenant_composite_keys_rollback'),
    ).toEqual([
      "PERFORM set_config('lock_timeout', '5s', true)",
      ...PARENTS.map((t) => `DROP INDEX IF EXISTS "${t}_tenantId_id_key"`),
    ]);
  });

  it('the pre-4C-2 schema used by the Prisma tests differs only by those keys', () => {
    expect(schemaWithoutKeys).not.toContain('@@unique([tenantId, id])');
    expect(
      schema.split('\n').length - schemaWithoutKeys.split('\n').length,
    ).toBe(25 * KEY_LINES.size);
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

  // Real `prisma migrate deploy`, exactly as CI and every environment run
  // it — not the scratch helper — against newly created, guarded scratch
  // databases. A temporary project (copies of the repo's migrations, a
  // schema and a plain config) stands in for "the migrations before 4C-2".
  describe('applied by real prisma migrate deploy', () => {
    const databaseDir = join(repoRoot, 'packages/database');
    const prismaBin = join(databaseDir, 'node_modules/.bin/prisma');
    const migrationsDir = join(databaseDir, 'prisma/migrations');
    const tempDirs: string[] = [];
    const scratches: ScratchDatabase[] = [];

    afterAll(async () => {
      for (const scratch of scratches) await scratch.drop();
      for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    });

    // A Prisma project with the given migrations (+ an optional extra one)
    // and schema; returns its config path.
    function project(
      names: string[],
      schemaText: string,
      extra?: { name: string; sql: string },
    ): string {
      const dir = mkdtempSync(join(tmpdir(), 'mh-4c2-prisma-'));
      tempDirs.push(dir);
      for (const name of names) {
        cpSync(join(migrationsDir, name), join(dir, 'migrations', name), {
          recursive: true,
        });
      }
      copyFileSync(
        join(migrationsDir, 'migration_lock.toml'),
        join(dir, 'migrations', 'migration_lock.toml'),
      );
      if (extra) {
        cpSync(
          join(migrationsDir, names[0]),
          join(dir, 'migrations', extra.name),
          {
            recursive: true,
          },
        );
        writeFileSync(
          join(dir, 'migrations', extra.name, 'migration.sql'),
          extra.sql,
        );
      }
      writeFileSync(join(dir, 'schema.prisma'), schemaText);
      const config = join(dir, 'prisma.config.ts');
      writeFileSync(
        config,
        `export default { schema: ${JSON.stringify(join(dir, 'schema.prisma'))}, migrations: { path: ${JSON.stringify(join(dir, 'migrations'))} }, datasource: { url: process.env["DATABASE_URL"] } };\n`,
      );
      return config;
    }

    // Runs the Prisma CLI; without `config` it uses the repository's own.
    async function prisma(url: string, args: string[], config?: string) {
      const run = promisify(execFile);
      return run(
        prismaBin,
        [...args, ...(config ? ['--config', config] : [])],
        {
          cwd: databaseDir,
          env: { ...process.env, DATABASE_URL: url },
          timeout: 180_000,
        },
      ).then(
        (r) => ({ code: 0, out: `${r.stdout}${r.stderr}` }),
        (e: { code?: number; stdout?: string; stderr?: string }) => ({
          code: e.code ?? 1,
          out: `${e.stdout ?? ''}${e.stderr ?? ''}`,
        }),
      );
    }

    const beforeNames = migrations.slice(0, targetIndex).map((m) => m.name);
    const fresh = async (label: string) => {
      const scratch = await createScratchDatabase(baseUrl, label);
      scratches.push(scratch);
      return scratch;
    };
    const atPreviousMigration = async (label: string) => {
      const scratch = await fresh(label);
      const result = await prisma(
        scratch.url,
        ['migrate', 'deploy'],
        project(beforeNames, schemaWithoutKeys),
      );
      expect(result.code).toBe(0);
      expect(await tablesWithCompositeKey(scratch.url)).toEqual([]);
      return scratch;
    };
    const migrationRow = async (url: string) =>
      (
        await query<{ finished: boolean; rolled_back: boolean }>(
          url,
          `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
             FROM _prisma_migrations WHERE migration_name = '${MIGRATION}'
            ORDER BY started_at`,
        )
      ).map(
        (r) =>
          `${r.finished ? 'finished' : 'unfinished'}${r.rolled_back ? '+rolled-back' : ''}`,
      );
    const noDrift = async (url: string, config?: string) =>
      (
        await prisma(
          url,
          [
            'migrate',
            'diff',
            '--from-config-datasource',
            '--to-schema',
            config
              ? join(config, '..', 'schema.prisma')
              : 'prisma/schema.prisma',
            '--exit-code',
          ],
          config,
        )
      ).code;

    it('a successful deploy creates exactly the 25 keys, and schema and database stay identical', async () => {
      const scratch = await fresh('prisma_ok');
      const result = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(result.code).toBe(0);
      expect(await tablesWithCompositeKey(scratch.url)).toEqual(PARENTS);
      expect(await migrationRow(scratch.url)).toEqual(['finished']);
      expect(await noDrift(scratch.url)).toBe(0);
    });

    it('a failure at the LAST index leaves zero new indexes, is recorded as failed, cannot be retried as success, and recovers by the documented procedure', async () => {
      const scratch = await atPreviousMigration('prisma_fail');
      // Occupy the name of the 25th (last) index so its CREATE fails.
      await query(
        scratch.url,
        `CREATE INDEX "${PARENTS[PARENTS.length - 1]}_tenantId_id_key" ON "Category"(name)`,
      );

      const failed = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(failed.code).not.toBe(0);
      expect(failed.out).toContain('P3018');
      expect(await tablesWithCompositeKey(scratch.url)).toEqual([]);
      expect(await migrationRow(scratch.url)).toEqual(['unfinished']);

      // A plain retry is refused — never silently reported as applied.
      const retried = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(retried.code).not.toBe(0);
      expect(retried.out).toContain('P3009');
      expect(await tablesWithCompositeKey(scratch.url)).toEqual([]);

      // Documented recovery: remove the cause, mark the failed attempt
      // rolled back (nothing was applied), deploy again.
      await query(
        scratch.url,
        `DROP INDEX "${PARENTS[PARENTS.length - 1]}_tenantId_id_key"`,
      );
      const resolved = await prisma(scratch.url, [
        'migrate',
        'resolve',
        '--rolled-back',
        MIGRATION,
      ]);
      expect(resolved.code).toBe(0);
      const recovered = await prisma(scratch.url, ['migrate', 'deploy']);
      expect(recovered.code).toBe(0);
      expect(await tablesWithCompositeKey(scratch.url)).toEqual(PARENTS);
      expect(await migrationRow(scratch.url)).toEqual([
        'unfinished+rolled-back',
        'finished',
      ]);
      expect(await noDrift(scratch.url)).toBe(0);
    });

    it('a lock it cannot get makes it fail fast (lock_timeout) and atomically, instead of queueing writes', async () => {
      const scratch = await atPreviousMigration('prisma_lock');
      const holder = await withScratchClient(scratch.url, async (client) => {
        // Hold a writer's lock on the last table for the whole deploy.
        await client.query('BEGIN');
        await client.query(
          `LOCK TABLE "${PARENTS[PARENTS.length - 1]}" IN ROW EXCLUSIVE MODE`,
        );
        const started = Date.now();
        const result = await prisma(scratch.url, ['migrate', 'deploy']);
        await client.query('ROLLBACK');
        return { result, seconds: (Date.now() - started) / 1000 };
      });
      expect(holder.result.code).not.toBe(0);
      expect(holder.result.out).toMatch(/lock timeout/i);
      expect(holder.seconds).toBeLessThan(60);
      expect(await tablesWithCompositeKey(scratch.url)).toEqual([]);
      expect(await migrationRow(scratch.url)).toEqual(['unfinished']);
    });

    it('the documented rollback — shipped as a new forward migration with the schema reverted — restores the pre-4C-2 schema exactly', async () => {
      const scratch = await fresh('prisma_rollback');
      expect((await prisma(scratch.url, ['migrate', 'deploy'])).code).toBe(0);
      expect(await tablesWithCompositeKey(scratch.url)).toEqual(PARENTS);
      const config = project(
        migrations.map((m) => m.name),
        schemaWithoutKeys,
        {
          name: '20261011100000_rollback_tenant_composite_keys',
          sql: rollbackSql,
        },
      );
      expect(
        (await prisma(scratch.url, ['migrate', 'deploy'], config)).code,
      ).toBe(0);
      expect(await tablesWithCompositeKey(scratch.url)).toEqual([]);
      expect(await noDrift(scratch.url, config)).toBe(0);
    });
  });
});
