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

// SC0.5b — gift-card ADJUSTMENT operation keys become unique per business
// (migration 20261021090000_tenant_giftcard_adjustment_operation_key).
// Exercised through the REAL migration SQL and its rollback on scratch
// databases: existing ledger data is carried over untouched, same-business
// idempotency still holds, two businesses may share a key, and the rollback
// refuses once they do.

jest.setTimeout(300_000);

const databasePackage = join(__dirname, '../../../../packages/database');
const migrations = listMigrations(join(databasePackage, 'prisma/migrations'));
const targetIndex = migrations.findIndex((m) =>
  m.name.endsWith('_tenant_giftcard_adjustment_operation_key'),
);
const beforeTarget = migrations.slice(0, targetIndex);
const target = migrations[targetIndex];
const rollbackSql = readFileSync(
  join(
    databasePackage,
    'prisma/rollbacks/20261021090000_tenant_giftcard_adjustment_operation_key.down.sql',
  ),
  'utf8',
);
const baseUrl = process.env.DATABASE_URL!;

const A = '01a0db02-f800-7000-8000-5b0b0000000a';
const B = '01a0db02-f800-7000-8000-5b0b0000000b';
const OLD_INDEX = 'GiftCardTransaction_adjustment_operationKey_key';
const NEW_INDEX = 'GiftCardTransaction_adjustment_tenantId_operationKey_key';

async function run(url: string, sql: string) {
  return withScratchClient(url, (client) => client.query(sql));
}
async function rows<T = Record<string, unknown>>(
  url: string,
  sql: string,
): Promise<T[]> {
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
async function errorMessage(url: string, sql: string): Promise<string> {
  try {
    await run(url, sql);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

const FIXTURES = [
  `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES
     ('${A}', 'tenant-a', 'A', 'ACTIVE', now()),
     ('${B}', 'tenant-b', 'B', 'ACTIVE', now())`,
  `INSERT INTO "InternalUser" (id, "externalProvider", email, "updatedAt", "tenantId") VALUES
     ('iu-a', 'internal-dev', 'a@example.test', now(), '${A}'),
     ('iu-b', 'internal-dev', 'b@example.test', now(), '${B}')`,
  `INSERT INTO "GiftCard" (id, "codeHash", last4, "originalValueMinorUnits", "balanceMinorUnits", "updatedAt", "tenantId") VALUES
     ('gc-a1', 'hash-a1', '0001', 2500, 2600, now(), '${A}'),
     ('gc-a2', 'hash-a2', '0002', 2500, 2500, now(), '${A}'),
     ('gc-b1', 'hash-b1', '0003', 2500, 2400, now(), '${B}')`,
];

const issuance = (id: string, card: string, tenant: string) =>
  `INSERT INTO "GiftCardTransaction" (id, "giftCardId", type, "amountMinorUnits", "balanceAfterMinorUnits", "tenantId")
   VALUES ('${id}', '${card}', 'ISSUANCE', 2500, 2500, '${tenant}')`;
const adjustment = (
  id: string,
  card: string,
  tenant: string,
  key: string,
  amount = 100,
  balanceAfter = 2600,
) =>
  `INSERT INTO "GiftCardTransaction" (id, "giftCardId", type, "amountMinorUnits", "balanceAfterMinorUnits", reason, "actorInternalUserId", "operationKey", "tenantId")
   VALUES ('${id}', '${card}', 'ADJUSTMENT', ${amount}, ${balanceAfter}, 'fix', 'iu-${tenant === A ? 'a' : 'b'}', '${key}', '${tenant}')`;

// The pre-migration ledger: every ADJUSTMENT key globally unique, as the old
// index required.
const LEDGER = [
  issuance('t-a1-i', 'gc-a1', A),
  issuance('t-a2-i', 'gc-a2', A),
  issuance('t-b1-i', 'gc-b1', B),
  adjustment('t-a1-adj', 'gc-a1', A, 'key-legacy-a'),
  adjustment('t-b1-adj', 'gc-b1', B, 'key-legacy-b', -100, 2400),
];

const indexes = (url: string) =>
  rows<{ indexname: string; indexdef: string }>(
    url,
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'GiftCardTransaction' AND indexname IN ('${OLD_INDEX}', '${NEW_INDEX}')
      ORDER BY indexname`,
  );
const ledgerSnapshot = (url: string) =>
  rows(
    url,
    `SELECT id, "giftCardId", type, "amountMinorUnits", "balanceAfterMinorUnits", "operationKey", "tenantId"
       FROM "GiftCardTransaction" ORDER BY id`,
  );
const balances = (url: string) =>
  rows(url, `SELECT id, "balanceMinorUnits" FROM "GiftCard" ORDER BY id`);

describe('SC0.5b: per-business gift-card adjustment operation keys (migration)', () => {
  const scratches: ScratchDatabase[] = [];
  const fresh = async (label: string) => {
    const scratch = await createScratchDatabase(baseUrl, label);
    scratches.push(scratch);
    return scratch;
  };
  afterAll(async () => {
    for (const scratch of scratches) await scratch.drop();
  });

  // A database at the migration's predecessor, holding the legacy ledger.
  async function legacyDatabase(label: string) {
    const db = await fresh(label);
    await applyMigrations(db.url, beforeTarget);
    for (const statement of [...FIXTURES, ...LEDGER]) {
      await run(db.url, statement);
    }
    return db;
  }

  it('runs after tenant isolation phase 2 (NOT NULL tenantId) in the chain', () => {
    expect(targetIndex).toBeGreaterThan(0);
    expect(
      beforeTarget.some((m) => m.name.endsWith('_tenant_isolation_phase_2')),
    ).toBe(true);
  });

  describe('applied to existing data', () => {
    let db: ScratchDatabase;
    let ledgerBefore: Record<string, unknown>[];
    let balancesBefore: Record<string, unknown>[];

    beforeAll(async () => {
      db = await legacyDatabase('sc05b_apply');
      ledgerBefore = await ledgerSnapshot(db.url);
      balancesBefore = await balances(db.url);
      await applyMigrationSql(db.url, target.sql);
    });

    it('replaces the global index with a per-business one', async () => {
      const found = await indexes(db.url);
      expect(found.map((i) => i.indexname)).toEqual([NEW_INDEX]);
      expect(found[0].indexdef).toContain('("tenantId", "operationKey")');
      expect(found[0].indexdef).toMatch(/WHERE .*ADJUSTMENT/);
    });

    it('changes no ledger entry and no balance', async () => {
      expect(await ledgerSnapshot(db.url)).toEqual(ledgerBefore);
      expect(await balances(db.url)).toEqual(balancesBefore);
    });

    it('still refuses a repeated key inside one business (idempotency kept)', async () => {
      expect(
        await sqlState(
          db.url,
          adjustment('t-a2-dup', 'gc-a2', A, 'key-legacy-a'),
        ),
      ).toBe('23505');
    });

    it('lets another business use a key already used by the first', async () => {
      expect(
        await sqlState(
          db.url,
          adjustment('t-b1-shared', 'gc-b1', B, 'key-legacy-a', 50, 2450),
        ),
      ).toBeNull();
    });

    it('leaves non-ADJUSTMENT entries and keyless rows outside the index', async () => {
      // Two ISSUANCE rows of different cards with no key, and an ADJUSTMENT
      // with no key, are unaffected by the operationKey index.
      expect(
        await sqlState(
          db.url,
          `INSERT INTO "GiftCardTransaction" (id, "giftCardId", type, "amountMinorUnits", "balanceAfterMinorUnits", reason, "actorInternalUserId", "tenantId")
           VALUES ('t-a2-nokey-1', 'gc-a2', 'ADJUSTMENT', 1, 2501, 'fix', 'iu-a', '${A}'),
                  ('t-a2-nokey-2', 'gc-a2', 'ADJUSTMENT', 1, 2502, 'fix', 'iu-a', '${A}')`,
        ),
      ).toBeNull();
    });
  });

  describe('preflight', () => {
    it('refuses, changing nothing, when the per-business index already exists', async () => {
      const db = await legacyDatabase('sc05b_twice');
      await run(
        db.url,
        `CREATE UNIQUE INDEX "${NEW_INDEX}" ON "GiftCardTransaction"("tenantId", "operationKey") WHERE "type" = 'ADJUSTMENT'`,
      );
      expect(await errorMessage(db.url, target.sql)).toContain(
        'already exists. Nothing was changed.',
      );
      expect((await indexes(db.url)).map((i) => i.indexname)).toEqual([
        OLD_INDEX,
        NEW_INDEX,
      ]);
    });

    it('refuses, changing nothing, when the global index is not the one it expects', async () => {
      const db = await legacyDatabase('sc05b_noold');
      await run(db.url, `DROP INDEX "${OLD_INDEX}"`);
      expect(await errorMessage(db.url, target.sql)).toContain(
        'expects the global index',
      );
      expect(await indexes(db.url)).toEqual([]);
    });
  });

  describe('rollback', () => {
    it('restores the global index while keys are still unique across businesses', async () => {
      const db = await legacyDatabase('sc05b_rollback');
      const ledgerBefore = await ledgerSnapshot(db.url);
      await applyMigrationSql(db.url, target.sql);
      await applyMigrationSql(db.url, rollbackSql);
      expect((await indexes(db.url)).map((i) => i.indexname)).toEqual([
        OLD_INDEX,
      ]);
      expect(await ledgerSnapshot(db.url)).toEqual(ledgerBefore);
    });

    it('refuses, changing nothing, once two businesses share a key', async () => {
      const db = await legacyDatabase('sc05b_rollback_refused');
      await applyMigrationSql(db.url, target.sql);
      await run(
        db.url,
        adjustment('t-b1-shared', 'gc-b1', B, 'key-legacy-a', 50, 2450),
      );
      expect(await errorMessage(db.url, rollbackSql)).toContain(
        'rollback refused',
      );
      expect((await indexes(db.url)).map((i) => i.indexname)).toEqual([
        NEW_INDEX,
      ]);
    });
  });
});
