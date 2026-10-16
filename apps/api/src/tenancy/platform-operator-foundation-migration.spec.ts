import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';

// SC1a — migration 20261022090000_platform_operator_foundation, through the
// REAL migration SQL and its rollback on scratch databases: additive only,
// no tenant data touched, the constraints that keep the platform tables
// honest, and a rollback that refuses to destroy operators or audit history.

jest.setTimeout(300_000);

const databasePackage = join(__dirname, '../../../../packages/database');
const migrations = listMigrations(join(databasePackage, 'prisma/migrations'));
const targetIndex = migrations.findIndex((m) =>
  m.name.endsWith('_platform_operator_foundation'),
);
const beforeTarget = migrations.slice(0, targetIndex);
const target = migrations[targetIndex];
const rollbackSql = readFileSync(
  join(
    databasePackage,
    'prisma/rollbacks/20261022090000_platform_operator_foundation.down.sql',
  ),
  'utf8',
);
const baseUrl = process.env.DATABASE_URL!;

async function run(url: string, sql: string) {
  return withScratchClient(url, (client) => client.query(sql));
}
async function rows<T = Record<string, unknown>>(url: string, sql: string) {
  return (await run(url, sql)).rows as T[];
}
async function sqlState(url: string, sql: string): Promise<string | null> {
  try {
    await run(url, sql);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

const operator = (
  id: string,
  overrides: Partial<Record<string, string>> = {},
) => {
  const v = {
    provider: 'cognito-platform',
    subject: `sub-${id}`,
    email: `${id}@example.test`,
    status: 'ACTIVE',
    ...overrides,
  };
  return `INSERT INTO "PlatformOperator" (id, "externalProvider", "externalSubject", email, status, "updatedAt")
          VALUES ('${id}', '${v.provider}', '${v.subject}', '${v.email}', '${v.status}', now())`;
};

describe('SC1a: platform operator foundation (migration)', () => {
  const scratches: ScratchDatabase[] = [];
  const fresh = async (label: string) => {
    const scratch = await createScratchDatabase(baseUrl, label);
    scratches.push(scratch);
    await applyMigrations(scratch.url, beforeTarget);
    return scratch;
  };
  afterAll(async () => {
    for (const scratch of scratches) await scratch.drop();
  });

  let db: ScratchDatabase;
  let tablesBefore: string[];
  beforeAll(async () => {
    db = await fresh('sc1a_platform');
    tablesBefore = (
      await rows<{ table_name: string }>(
        db.url,
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
      )
    ).map((r) => r.table_name);
    await applyMigrationSql(db.url, target.sql);
  });

  it('adds exactly the two platform tables, neither with a tenantId', async () => {
    const after = (
      await rows<{ table_name: string }>(
        db.url,
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
      )
    ).map((r) => r.table_name);
    expect(after.filter((t) => !tablesBefore.includes(t)).sort()).toEqual([
      'PlatformAuditEvent',
      'PlatformOperator',
    ]);
    expect(
      await rows(
        db.url,
        `SELECT table_name FROM information_schema.columns
          WHERE table_name IN ('PlatformOperator', 'PlatformAuditEvent') AND column_name = 'tenantId'`,
      ),
    ).toEqual([]);
  });

  it('creates no operator and gives status no default', async () => {
    expect(
      await rows(db.url, `SELECT count(*)::int AS n FROM "PlatformOperator"`),
    ).toEqual([{ n: 0 }]);
    expect(
      await sqlState(
        db.url,
        `INSERT INTO "PlatformOperator" (id, "externalProvider", "externalSubject", email, "updatedAt")
         VALUES ('no-status', 'cognito-platform', 's', 'no-status@example.test', now())`,
      ),
    ).toBe('23502');
  });

  it('identifies an operator by (provider, subject), uniquely, and keeps emails unique and lower-case', async () => {
    expect(await sqlState(db.url, operator('op-1'))).toBeNull();
    // Same identity again -> unique violation.
    expect(
      await sqlState(
        db.url,
        operator('op-2', { subject: 'sub-op-1', email: 'op-2@example.test' }),
      ),
    ).toBe('23505');
    // The same subject under the OTHER provider is a different identity.
    expect(
      await sqlState(
        db.url,
        operator('op-3', {
          provider: 'platform-dev',
          subject: 'sub-op-1',
          email: 'op-3@example.test',
        }),
      ),
    ).toBeNull();
    expect(
      await sqlState(db.url, operator('op-4', { email: 'op-1@example.test' })),
    ).toBe('23505');
    expect(
      await sqlState(db.url, operator('op-5', { email: 'Op-5@Example.test' })),
    ).toBe('23514');
  });

  it.each([
    ['an unknown provider', { provider: 'cognito-internal' }],
    ['a blank subject', { subject: ' ' }],
    ['a malformed email', { email: 'no-at-sign' }],
  ])('refuses %s (CHECK)', async (label, overrides) => {
    expect(
      await sqlState(
        db.url,
        operator(`bad-${label.length}`, {
          email: `bad-${label.length}@example.test`,
          ...overrides,
        }),
      ),
    ).toBe('23514');
  });

  it('audit events take machine codes only, and an operator with audit history cannot be deleted', async () => {
    const audit = (id: string, action: string, reason: string | null) =>
      `INSERT INTO "PlatformAuditEvent" (id, "actorPlatformOperatorId", action, outcome, "reasonCode")
       VALUES ('${id}', 'op-1', '${action}', 'DENIED', ${reason === null ? 'NULL' : `'${reason}'`})`;
    expect(
      await sqlState(
        db.url,
        audit('ae-1', 'platform.access.denied', 'OPERATOR_DISABLED'),
      ),
    ).toBeNull();
    expect(
      await sqlState(db.url, audit('ae-2', 'Free text action', null)),
    ).toBe('23514');
    expect(
      await sqlState(
        db.url,
        audit('ae-3', 'platform.access.denied', 'free text'),
      ),
    ).toBe('23514');
    // Refused by the RESTRICT foreign key (restrict / foreign-key violation).
    expect(['23001', '23503']).toContain(
      await sqlState(
        db.url,
        `DELETE FROM "PlatformOperator" WHERE id = 'op-1'`,
      ),
    );
    expect(
      await rows(db.url, `SELECT id FROM "PlatformOperator" WHERE id = 'op-1'`),
    ).toEqual([{ id: 'op-1' }]);
  });

  it('the audit trail is append-only: UPDATE, DELETE and TRUNCATE are refused, rows are unchanged', async () => {
    const before = await rows(
      db.url,
      `SELECT id, action, outcome, "reasonCode" FROM "PlatformAuditEvent" ORDER BY id`,
    );
    expect(before.length).toBeGreaterThan(0);
    for (const statement of [
      `UPDATE "PlatformAuditEvent" SET "reasonCode" = 'TAMPERED'`,
      `DELETE FROM "PlatformAuditEvent"`,
      `TRUNCATE "PlatformAuditEvent"`,
    ]) {
      expect({ statement, state: await sqlState(db.url, statement) }).toEqual({
        statement,
        state: '23001',
      });
    }
    expect(
      await rows(
        db.url,
        `SELECT id, action, outcome, "reasonCode" FROM "PlatformAuditEvent" ORDER BY id`,
      ),
    ).toEqual(before);
  });

  describe('rollback', () => {
    it('refuses, changing nothing, while operators or audit events exist', async () => {
      await expect(applyMigrationSql(db.url, rollbackSql)).rejects.toThrow(
        'SC1a rollback refused',
      );
      expect(
        await rows(db.url, `SELECT count(*)::int AS n FROM "PlatformOperator"`),
      ).toEqual([{ n: 2 }]);
    });

    it('removes exactly what the migration added when nothing was provisioned', async () => {
      const empty = await fresh('sc1a_platform_rollback');
      const before = await rows(
        empty.url,
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
      );
      await applyMigrationSql(empty.url, target.sql);
      await applyMigrationSql(empty.url, rollbackSql);
      expect(
        await rows(
          empty.url,
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
        ),
      ).toEqual(before);
      expect(
        await rows(
          empty.url,
          `SELECT typname FROM pg_type WHERE typname IN ('PlatformOperatorStatus', 'PlatformAuditOutcome')`,
        ),
      ).toEqual([]);
    });
  });
});
