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

// SC4f-3b — migration 20261113090000_loyalty_points_label, on scratch
// databases: an existing loyalty configuration comes through unchanged (no
// label: it keeps showing what it showed); the label is bounded by the
// database too; and a rollback that refuses while any business has chosen
// a name and otherwise removes the column.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const THIS_MIGRATION = '20261113090000_loyalty_points_label';
const ROLLBACK = join(
  __dirname,
  `../../../../packages/database/prisma/rollbacks/${THIS_MIGRATION}.down.sql`,
);

jest.setTimeout(180_000);

describe('SC4f-3b loyalty points label migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  const query = (text: string, params: unknown[] = []) =>
    withScratchClient(scratch.url, (c) =>
      c.query<Record<string, unknown>>(text, params),
    );
  const setLabel = (label: string | null) =>
    query(
      `UPDATE "LoyaltyConfiguration" SET "pointsLabel" = $1 WHERE "tenantId" = $2 AND key = 'company'`,
      [label, TENANT_1_MOCHA_HOUSE_ID],
    );

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4f3b_migration',
    );
    const all = listMigrations(MIGRATIONS);
    const at = all.findIndex((m) => m.name === THIS_MIGRATION);
    expect(at).toBeGreaterThan(0);
    await applyMigrations(scratch.url, all.slice(0, at));
    await query(
      `INSERT INTO "LoyaltyConfiguration" (id, "tenantId", key, "earningRatePerDollar", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, 'company', 3, now())
       ON CONFLICT DO NOTHING`,
      [TENANT_1_MOCHA_HOUSE_ID],
    );
    await applyMigrations(scratch.url, all.slice(at));
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('keeps the existing configuration unchanged, with no label chosen', async () => {
    const { rows } = await query(
      `SELECT "earningRatePerDollar", "pointsLabel" FROM "LoyaltyConfiguration" WHERE "tenantId" = $1 AND key = 'company'`,
      [TENANT_1_MOCHA_HOUSE_ID],
    );
    expect(rows).toEqual([{ earningRatePerDollar: 3, pointsLabel: null }]);
  });

  it('bounds the label in the database', async () => {
    await setLabel('Mocha Beans');
    for (const bad of ['', ' padded ', 'x'.repeat(33), 'tab\tname']) {
      await expect(setLabel(bad)).rejects.toThrow();
    }
    await setLabel(null);
  });

  it('the rollback refuses while any business has chosen a name', async () => {
    await setLabel('Stars');
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    await setLabel(null);
  });

  it('the rollback removes the column when no name is chosen', async () => {
    await applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8'));
    const { rows } = await query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'LoyaltyConfiguration' AND column_name = 'pointsLabel'`,
    );
    expect(rows).toEqual([]);
    const config = await query(
      `SELECT "earningRatePerDollar" FROM "LoyaltyConfiguration" WHERE "tenantId" = $1`,
      [TENANT_1_MOCHA_HOUSE_ID],
    );
    expect(config.rows).toEqual([{ earningRatePerDollar: 3 }]);
  });
});
