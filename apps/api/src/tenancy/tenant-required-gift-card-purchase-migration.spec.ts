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

// Milestone S0D-2C-1B — the guarded, parent-derived backfill + NOT NULL
// migration for GiftCardPurchase ONLY, exercised on a throwaway scratch
// database starting from the exact post-S0D-2D state. This closes the
// payment core's second PaymentAttempt child (Order was converted in
// S0D-2C-1) — it is NOT general Gift Card domain tenancy work.
//
// Unlike S0D-2C-1 / S0D-2D, this migration carries NO single-tenant guard
// and NO Tenant #1 fallback tier: every GiftCardPurchase row has a
// required, unique paymentAttemptId, and PaymentAttempt.tenantId has been
// NOT NULL since S0D-2C-1, so the backfill is unconditionally derivable
// from the parent alone. One of the tests below proves this concretely by
// running the migration with a second tenant present and confirming it
// still succeeds.

jest.setTimeout(180_000);

const repoRoot = join(__dirname, '../../../..');
const migrations = listMigrations(
  join(repoRoot, 'packages/database/prisma/migrations'),
);
const targetIndex = migrations.findIndex((m) =>
  m.name.endsWith('_require_tenant_id_gift_card_purchase'),
);
const before = migrations.slice(0, targetIndex);
const target = migrations[targetIndex];

const CONVERTED = ['GiftCardPurchase'];
// Models already NOT NULL before this migration (S0D-2A, S0D-2B-1,
// S0D-2B-2, S0D-2C-1, S0D-2D) plus GiftCardPurchase, converted here.
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
  'CustomerPreferredLocation',
  'CustomerNote',
  'PaymentAttempt',
  'Order',
  'OrderLine',
  'OrderStatusHistory',
  'JobOpening',
  'JobApplication',
  'JobApplicationNote',
  'FranchiseInquiry',
  'FranchiseInquiryNote',
  ...CONVERTED,
]);
const tenantTables = Object.entries(MODEL_TENANCY)
  .filter(([, tenancy]) => tenancy === 'tenant')
  .map(([model]) => model)
  // Milestone S0D-2C-3 added NotificationRecipient AFTER this migration;
  // this test is pinned to the schema exactly as it existed at `target`,
  // which never has that table.
  .filter((model) => model !== 'NotificationRecipient');

const baseUrl = process.env.DATABASE_URL!;
const T1 = TENANT_1_MOCHA_HOUSE_ID;

// Window rows: one PaymentAttempt + GiftCardPurchase pair, written in the
// nullable window (gcp-w.tenantId omitted -> NULL).
const WINDOW_ROWS_SQL = `
INSERT INTO "PaymentAttempt" (id, "idempotencyKey", provider, status, amount, currency, "updatedAt", "tenantId")
  VALUES ('pa-gcp-w', 'k-gcp-w', 'fake', 'SUCCEEDED', 2500, 'USD', now(), '${T1}');
INSERT INTO "GiftCardPurchase" (id, "paymentAttemptId", "amountMinorUnits", "purchaserEmail", "updatedAt")
  VALUES ('gcp-w', 'pa-gcp-w', 2500, 'window@example.com', now());
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
  const rows = await query<{ id: string; tenantId: string | null }>(
    url,
    `SELECT id, "tenantId" FROM "${table}" ORDER BY id`,
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.tenantId]));
}

async function convertedStillNull(url: string) {
  const columns = await nullability(url);
  for (const table of CONVERTED) {
    expect({ table, nullable: columns[table] }).toEqual({
      table,
      nullable: 'YES',
    });
    const ids = await tenantIds(url, table);
    for (const [id, tenantId] of Object.entries(ids)) {
      expect({ table, id, tenantId }).toEqual({ table, id, tenantId: null });
    }
  }
}

// Everything the migration must NOT change: constraints, indexes, triggers
// and column defaults across the schema, plus the enum catalogue.
async function structure(url: string) {
  const pick = async (sql: string) =>
    (await query<{ def: string }>(url, sql)).map((r) => r.def);
  return {
    constraints: await pick(
      `SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1`,
    ),
    indexes: await pick(
      `SELECT indexdef AS def FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
    ),
    triggers: await pick(
      `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`,
    ),
    defaults: await pick(
      `SELECT table_name || '.' || column_name || '=' || column_default AS def
         FROM information_schema.columns
        WHERE table_schema = 'public' AND column_default IS NOT NULL ORDER BY 1`,
    ),
    enums: await pick(
      `SELECT t.typname || '.' || e.enumlabel AS def
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid ORDER BY 1`,
    ),
  };
}

// Plants a row state the application and the FKs would never allow, by
// skipping FK enforcement for ONE statement batch on the scratch database
// only. Used to prove the disagreement guard fires.
async function withoutFkChecks(url: string, sql: string) {
  await applyMigrationSql(
    url,
    `SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`,
  );
}

async function expectAbort(url: string, message: RegExp) {
  await expect(applyMigrationSql(url, target.sql)).rejects.toThrow(message);
}

describe('S0D-2C-1B GiftCardPurchase NOT NULL migration (scratch databases)', () => {
  let scratch: ScratchDatabase;
  let structureBefore: Awaited<ReturnType<typeof structure>>;

  beforeAll(async () => {
    scratch = await createScratchDatabase(baseUrl, 's0d2c1b');
    await applyMigrations(scratch.url, before);
    await applyMigrationSql(scratch.url, WINDOW_ROWS_SQL);
    structureBefore = await structure(scratch.url);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('follows S0D-2D, is atomic, alters ONLY GiftCardPurchase, carries no single-tenant guard, and orders backfill → check → NOT NULL', () => {
    expect(targetIndex).toBeGreaterThan(0);
    expect(before[before.length - 1].name).toMatch(
      /_require_tenant_id_careers_franchising$/,
    );
    expect(isAppliedAtomically(target.sql)).toBe(true);

    const altered = [
      ...target.sql.matchAll(
        /ALTER TABLE "(\w+)" ALTER COLUMN "tenantId" SET NOT NULL;/g,
      ),
    ].map((m) => m[1]);
    expect(altered).toEqual(CONVERTED);
    expect(target.sql).not.toMatch(
      /ADD VALUE|CREATE TYPE|DEFAULT|UNIQUE|FOREIGN KEY|CREATE TRIGGER|DROP TRIGGER|CREATE INDEX|DROP /,
    );
    // No other model — including every other Gift Card model — is touched.
    expect(target.sql).not.toMatch(
      /"OutboxEvent"|"NotificationDelivery"|"GiftCard"[^P]|"GiftCardTransaction"|"OrderGiftCardRedemption"|"GiftCardConfiguration"/,
    );
    // No single-tenant guard logic anywhere in this migration (the header
    // comment explains why in prose, which is fine — this checks there is
    // no actual RAISE EXCEPTION / tenant-count guard like S0D-2C-1/S0D-2D
    // have).
    expect(target.sql).not.toMatch(/other_tenants|RAISE EXCEPTION[^;]*other than Tenant/);

    const at = (needle: string) => target.sql.indexOf(needle);
    const backfill = at('FROM "PaymentAttempt" AS pa');
    const disagreementCheck = at('disagrees with their PaymentAttempt');
    const noNullCheck = at('still has % row(s) with NULL tenantId');
    const alterStatement = at('ALTER TABLE "GiftCardPurchase"');
    expect(disagreementCheck).toBeLessThan(backfill);
    expect(backfill).toBeLessThan(noNullCheck);
    expect(noNullCheck).toBeLessThan(alterStatement);
  });

  it('succeeds even with a second tenant present — there is no single-tenant assumption to violate', async () => {
    await query(
      scratch.url,
      `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'test-tenant-b', 'B', 'ACTIVE', now())`,
      [TEST_TENANT_B_ID],
    );
    try {
      // A second tenant existing must NOT abort this migration (unlike
      // S0D-2C-1 / S0D-2D, which guard against exactly this).
      await expect(applyMigrationSql(scratch.url, target.sql)).resolves.toBeUndefined();
    } finally {
      // Roll the scratch DB back to the pre-migration nullable state for
      // the remaining tests: undo the NOT NULL, null the backfilled value,
      // and remove the extra tenant.
      await query(scratch.url, `ALTER TABLE "GiftCardPurchase" ALTER COLUMN "tenantId" DROP NOT NULL`);
      await query(scratch.url, `UPDATE "GiftCardPurchase" SET "tenantId" = NULL WHERE id = 'gcp-w'`);
      await query(scratch.url, `DELETE FROM "Tenant" WHERE id = $1`, [
        TEST_TENANT_B_ID,
      ]);
    }
    await convertedStillNull(scratch.url);
  });

  it('aborts, rolling everything back, on a GiftCardPurchase whose non-null tenantId disagrees with its PaymentAttempt', async () => {
    await withoutFkChecks(
      scratch.url,
      `UPDATE "GiftCardPurchase" SET "tenantId" = 'ghost' WHERE id = 'gcp-w';`,
    );
    try {
      await expectAbort(
        scratch.url,
        /1 GiftCardPurchase row\(s\) have a non-null tenantId that disagrees with their PaymentAttempt's tenant/,
      );
      const columns = await nullability(scratch.url);
      expect(columns.GiftCardPurchase).toBe('YES');
    } finally {
      await withoutFkChecks(
        scratch.url,
        `UPDATE "GiftCardPurchase" SET "tenantId" = NULL WHERE id = 'gcp-w';`,
      );
    }
    await convertedStillNull(scratch.url);
  });

  it('when the check passes: backfills from PaymentAttempt and makes ONLY GiftCardPurchase NOT NULL, changing nothing else', async () => {
    const notices: string[] = [];
    await withScratchClient(scratch.url, async (client) => {
      client.on('notice', (n) => notices.push(n.message ?? ''));
      await client.query(target.sql);
    });

    expect(
      notices.find((n) => n.includes('GiftCardPurchase -> ')),
    ).toMatch(/-> 1 row\(s\) from PaymentAttempt/);

    const ids = await tenantIds(scratch.url, 'GiftCardPurchase');
    expect(ids).toEqual({ 'gcp-w': T1 });

    // OutboxEvent and the rest of the Gift Card domain are untouched.
    expect((await nullability(scratch.url)).OutboxEvent).toBe('YES');
    expect((await nullability(scratch.url)).GiftCard).toBe('YES');
    expect((await nullability(scratch.url)).GiftCardTransaction).toBe('YES');

    const columns = await nullability(scratch.url);
    for (const table of tenantTables) {
      expect({ table, nullable: columns[table] }).toEqual({
        table,
        nullable: REQUIRED_AFTER.has(table) ? 'NO' : 'YES',
      });
    }
    expect(tenantTables.filter((t) => columns[t] === 'NO')).toHaveLength(29);
    expect(tenantTables.filter((t) => columns[t] === 'YES')).toHaveLength(34);
    expect(TENANT_ID_REQUIRED_MODELS).toEqual(
      expect.arrayContaining([...REQUIRED_AFTER]),
    );

    // No default, and no constraint / index / trigger / enum change.
    expect(await structure(scratch.url)).toEqual(structureBefore);
  });

  it('afterwards refuses a tenantless GiftCardPurchase', async () => {
    await expect(
      applyMigrationSql(
        scratch.url,
        `INSERT INTO "GiftCardPurchase" (id, "paymentAttemptId", "amountMinorUnits", "purchaserEmail", "updatedAt")
           VALUES ('gcp-x', 'pa-gcp-w', 100, 'x@example.com', now())`,
      ),
    ).rejects.toThrow(/null value in column "tenantId"/);
  });
});
