import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
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

// Security 4B — automated regression tests for migration
// 20261010120000_tenant_isolation_phase_2, on throwaway scratch databases
// only (never an existing environment). Each scenario starts from the exact
// schema before the migration, loads fictional legacy rows (tenantId NULL)
// and runs the migration SQL exactly as Prisma would (one atomic batch).
//
//   derivable   — every row reachable through a reliable relationship
//   unresolved  — rows with no relationship that names a business
//   conflict    — a row whose evidence names two businesses
//   mismatch    — a child that disagrees with its parent's business
//
// The migration must assign only derivable rows, abort on anything else
// with nothing changed, never default to Tenant #1, and succeed once the
// problem rows are resolved.

jest.setTimeout(300_000);

const repoRoot = join(__dirname, '../../../..');
const migrations = listMigrations(
  join(repoRoot, 'packages/database/prisma/migrations'),
);
const targetIndex = migrations.findIndex((m) =>
  m.name.endsWith('_tenant_isolation_phase_2'),
);
const before = migrations.slice(0, targetIndex);
const target = migrations[targetIndex];

const fixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', `phase-2-${name}.sql`), 'utf8');

// The 28 tables the migration converts, read from the migration itself.
const CONVERTED = [
  ...(target?.sql ?? '').matchAll(
    /ALTER TABLE "(\w+)" ALTER COLUMN "tenantId" SET NOT NULL;/g,
  ),
].map((m) => m[1]);

const baseUrl = process.env.DATABASE_URL!;
const A = TENANT_1_MOCHA_HOUSE_ID;
const B = TEST_TENANT_B_ID;

async function query<T extends object>(url: string, sql: string) {
  return withScratchClient(url, async (client) => {
    const { rows } = await client.query<T>(sql);
    return rows;
  });
}

async function nullTenantRows(url: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of CONVERTED) {
    const [row] = await query<{ n: string }>(
      url,
      `SELECT count(*)::text AS n FROM "${table}" WHERE "tenantId" IS NULL`,
    );
    if (Number(row.n) > 0) counts[table] = Number(row.n);
  }
  return counts;
}

async function nullableTables(url: string): Promise<string[]> {
  const rows = await query<{ table_name: string }>(
    url,
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenantId'
        AND is_nullable = 'YES' ORDER BY 1`,
  );
  return rows.map((r) => r.table_name);
}

async function indexes(url: string): Promise<string[]> {
  return (
    await query<{ indexname: string }>(
      url,
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
    )
  ).map((r) => r.indexname);
}

// Balances and totals that must be identical before and after.
async function financials(url: string) {
  const [row] = await query<Record<string, string>>(
    url,
    `SELECT
       (SELECT coalesce(sum("balanceMinorUnits"), 0) FROM "GiftCard")::text AS gift_card_balances,
       (SELECT coalesce(sum("amountMinorUnits"), 0) FROM "GiftCardTransaction")::text AS gift_card_transactions,
       (SELECT coalesce(sum(balance), 0) FROM "CustomerLoyaltyAccount")::text AS loyalty_balances,
       (SELECT coalesce(sum(amount), 0) FROM "MochaBeanLedgerEntry")::text AS ledger_total,
       (SELECT count(*) FROM "GiftCardTransaction")::text AS transactions,
       (SELECT count(*) FROM "MochaBeanLedgerEntry")::text AS ledger_entries`,
  );
  return row;
}

async function tenantOf(url: string, table: string, id: string) {
  const [row] = await query<{ tenantId: string | null }>(
    url,
    `SELECT "tenantId" FROM "${table}" WHERE id = '${id}'`,
  );
  return row?.tenantId;
}

async function scenario(label: string, fixtures: string[]) {
  const scratch = await createScratchDatabase(baseUrl, `p2_${label}`);
  await applyMigrations(scratch.url, before);
  for (const name of fixtures) {
    await applyMigrationSql(scratch.url, fixture(name));
  }
  return scratch;
}

async function expectSafeAbort(
  scratch: ScratchDatabase,
  expectedProblems: number,
) {
  const nullsBefore = await nullTenantRows(scratch.url);
  const indexesBefore = await indexes(scratch.url);
  const moneyBefore = await financials(scratch.url);

  await expect(applyMigrationSql(scratch.url, target.sql)).rejects.toThrow(
    new RegExp(
      `Tenant isolation phase 2 aborted: ${expectedProblems} row\\(s\\) have conflicting, missing or inconsistent business ownership`,
    ),
  );

  // Nothing changed: no row was assigned, no column became required, no
  // index was swapped, no balance moved.
  expect(await nullTenantRows(scratch.url)).toEqual(nullsBefore);
  expect(await nullableTables(scratch.url)).toEqual(
    expect.arrayContaining(CONVERTED),
  );
  expect(await indexes(scratch.url)).toEqual(indexesBefore);
  expect(await financials(scratch.url)).toEqual(moneyBefore);
}

describe('Tenant isolation phase 2 migration (scratch databases)', () => {
  const scratches: ScratchDatabase[] = [];
  afterAll(async () => {
    for (const scratch of scratches) await scratch.drop();
  });
  const track = (s: ScratchDatabase) => {
    scratches.push(s);
    return s;
  };

  it('is the latest tenant migration, applies atomically and converts 28 tables without naming any tenant', () => {
    expect(targetIndex).toBeGreaterThan(0);
    expect(isAppliedAtomically(target.sql)).toBe(true);
    expect(CONVERTED).toHaveLength(28);
    // Never assigns a hardcoded business (Tenant #1 or any other).
    expect(target.sql).not.toContain(A);
    expect(target.sql).not.toMatch(
      /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/,
    );
    // Checks run before any DDL.
    expect(target.sql.indexOf('RAISE EXCEPTION')).toBeLessThan(
      target.sql.indexOf('SET NOT NULL'),
    );
  });

  it('derivable: every legacy row is assigned to the business its relationships name; balances are unchanged', async () => {
    const scratch = track(await scenario('derivable', ['derivable']));
    expect(
      Object.keys(await nullTenantRows(scratch.url)).length,
    ).toBeGreaterThan(20);
    const moneyBefore = await financials(scratch.url);

    await applyMigrationSql(scratch.url, target.sql);

    expect(await nullTenantRows(scratch.url)).toEqual({});
    expect(await nullableTables(scratch.url)).toEqual([]);
    expect(await financials(scratch.url)).toEqual(moneyBefore);
    for (const [table, id] of [
      ['GiftCard', 'gc-bought'],
      ['GiftCard', 'gc-hq'],
      ['GiftCard', 'gc-audit'],
      ['GiftCardTransaction', 'gct2'],
      ['Promotion', 'promo'],
      ['Promotion', 'promo-audit'],
      ['LoyaltyReward', 'rw-free'],
      ['LoyaltyReward', 'rw-fixed'],
      ['LoyaltyBonusPromotion', 'bonus'],
      ['Campaign', 'camp'],
      ['ApprovalRequest', 'appr'],
      ['MediaAsset', 'media'],
      ['CmsPage', 'cms'],
      ['CustomerLoyaltyAccount', 'acct'],
      ['MochaBeanLedgerEntry', 'adj'],
      ['InternalAuditEvent', 'ev-user'],
    ] as const) {
      expect([
        table,
        id,
        await tenantOf(scratch.url, table, `a-${id}`),
      ]).toEqual([table, id, A]);
      expect([
        table,
        id,
        await tenantOf(scratch.url, table, `b-${id}`),
      ]).toEqual([table, id, B]);
    }
    expect(
      await tenantOf(scratch.url, 'LoyaltyConfiguration', 'cfg-loyalty'),
    ).toBe(A);

    // Per-business uniqueness replaced the global keys: business B may now
    // reuse business A's coupon code and catalog slug, but not twice.
    const idx = await indexes(scratch.url);
    for (const name of [
      'Promotion_tenantId_code_key',
      'Product_tenantId_slug_key',
      'LoyaltyConfiguration_tenantId_key_key',
      'CmsPage_tenantId_key_key',
    ]) {
      expect(idx).toContain(name);
    }
    expect(idx).not.toContain('Promotion_code_key');
    await applyMigrationSql(
      scratch.url,
      `INSERT INTO "Promotion"(id, name, kind, code, "discountType", "updatedAt", "tenantId")
         VALUES ('b-same-code', 'Same', 'COUPON', 'WELCOME10-A', 'PERCENTAGE_OFF', now(), '${B}')`,
    );
    await expect(
      applyMigrationSql(
        scratch.url,
        `INSERT INTO "Promotion"(id, name, kind, code, "discountType", "updatedAt", "tenantId")
           VALUES ('b-dup-code', 'Dup', 'COUPON', 'WELCOME10-A', 'PERCENTAGE_OFF', now(), '${B}')`,
      ),
    ).rejects.toThrow(/duplicate key/);
    // And no future row may omit its business.
    await expect(
      applyMigrationSql(
        scratch.url,
        `INSERT INTO "GiftCard"(id, "codeHash", last4, "originalValueMinorUnits", "updatedAt")
           VALUES ('no-tenant', 'h-none', '0000', 1, now())`,
      ),
    ).rejects.toThrow(/tenantId/);
  });

  it('dry run: reports the outcome and commits nothing', async () => {
    const scratch = track(await scenario('dryrun', ['derivable']));
    const nullsBefore = await nullTenantRows(scratch.url);
    await expect(
      applyMigrationSql(
        scratch.url,
        `SET centerivo.tenant_backfill_dry_run = 'on';\n${target.sql}`,
      ),
    ).rejects.toThrow(
      /DRY RUN complete: 0 problem row\(s\)\. Nothing was committed\./,
    );
    expect(await nullTenantRows(scratch.url)).toEqual(nullsBefore);
    expect(await nullableTables(scratch.url)).toEqual(
      expect.arrayContaining(CONVERTED),
    );
  });

  it('missing relationships: rows nothing can place abort the migration with nothing changed', async () => {
    const scratch = track(
      await scenario('unresolved', ['derivable', 'unresolved']),
    );
    await expectSafeAbort(scratch, 2);
    // Never silently given to Mocha House.
    expect(
      await tenantOf(scratch.url, 'LoyaltyReward', 'x-rw-orphan'),
    ).toBeNull();
    expect(await tenantOf(scratch.url, 'GiftCard', 'x-gc-orphan')).toBeNull();
  });

  it('conflicting ownership: evidence naming two businesses aborts with nothing changed', async () => {
    const scratch = track(
      await scenario('conflict', ['derivable', 'conflict']),
    );
    // The split promotion is reported as a conflict and as still-unassigned.
    await expectSafeAbort(scratch, 2);
    expect(
      await tenantOf(scratch.url, 'Promotion', 'x-promo-split'),
    ).toBeNull();
  });

  it('parent/child mismatch: a child that disagrees with its parent aborts with nothing changed', async () => {
    const scratch = track(
      await scenario('mismatch', ['derivable', 'mismatch']),
    );
    // Reported twice: as conflicting evidence on the campaign (its own
    // business vs its image's) and by the campaign/image agreement check.
    await expectSafeAbort(scratch, 2);
    expect(await tenantOf(scratch.url, 'Campaign', 'x-camp-mismatch')).toBe(A);
  });

  it('recovery: once the problem rows are resolved explicitly, the same migration succeeds', async () => {
    const scratch = track(
      await scenario('recovery', [
        'derivable',
        'unresolved',
        'conflict',
        'mismatch',
      ]),
    );
    await expect(applyMigrationSql(scratch.url, target.sql)).rejects.toThrow(
      /aborted/,
    );
    // An explicit, approved ownership decision for each problem row —
    // never a default business.
    await applyMigrationSql(
      scratch.url,
      `UPDATE "LoyaltyReward" SET "tenantId" = '${B}' WHERE id = 'x-rw-orphan';
       DELETE FROM "GiftCard" WHERE id = 'x-gc-orphan';
       DELETE FROM "PromotionLocation" WHERE "promotionId" = 'x-promo-split';
       UPDATE "Campaign" SET "mediaAssetId" = 'a-media' WHERE id = 'x-camp-mismatch';`,
    );
    const moneyBefore = await financials(scratch.url);
    await applyMigrationSql(scratch.url, target.sql);
    expect(await nullTenantRows(scratch.url)).toEqual({});
    expect(await nullableTables(scratch.url)).toEqual([]);
    expect(await financials(scratch.url)).toEqual(moneyBefore);
    expect(await tenantOf(scratch.url, 'LoyaltyReward', 'x-rw-orphan')).toBe(B);
    expect(await tenantOf(scratch.url, 'Promotion', 'x-promo-split')).toBe(A);
  });
});
