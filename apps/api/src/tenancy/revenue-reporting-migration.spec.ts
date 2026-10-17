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

// SC3f — migration 20261104090000_revenue_reporting, on scratch databases:
// the provider amount columns are captured all together or not at all,
// never negative where the provider never is, never cleared once known; the
// billing.reports.view permission; and a rollback that refuses while that
// permission was ever granted, and otherwise restores the SC3e-3 shape.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261104090000_revenue_reporting.down.sql',
);
const TENANT = '01a0db02-f800-7000-8000-7e5700003f01';
const FOUNDING_VERSION = '01a0db02-f800-7000-8000-00000000f002';

jest.setTimeout(120_000);

async function seed(url: string) {
  return withScratchClient(url, async (c) => {
    await c.query(
      `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'sc3f-mig', 'Mig', 'ACTIVE', now())`,
      [TENANT],
    );
    const subscription = (
      await c.query<{ id: string }>(
        `INSERT INTO "TenantSubscription" (id, "subscriberTenantId", "planVersionId", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, now()) RETURNING id`,
        [TENANT, FOUNDING_VERSION],
      )
    ).rows[0].id;
    const operator = (
      await c.query<{ id: string }>(
        `INSERT INTO "PlatformOperator" (id, "externalProvider", "externalSubject", email, status, "updatedAt")
         VALUES (gen_random_uuid()::text, 'platform-dev', 'platform-dev:sc3f-mig', 'sc3f-mig@example.test', 'ACTIVE', now()) RETURNING id`,
      )
    ).rows[0].id;
    const invoice = (
      await c.query<{ id: string }>(
        `INSERT INTO "BillingInvoice" (id, "subscriptionId", provider, "externalInvoiceId", "externalCustomerId",
           "externalSubscriptionId", status, currency, "totalMinorUnits", "amountDueMinorUnits", "amountPaidMinorUnits",
           "amountRemainingMinorUnits", "issuedAt", "paidAt", "syncedAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, 'stripe', 'in_sc3f_mig', 'cus_mig', 'sub_mig', 'paid', 'usd', 1100, 1100, 1100,
           0, now(), now(), now(), now()) RETURNING id`,
        [subscription],
      )
    ).rows[0].id;
    return { operator, invoice };
  });
}

describe('SC3f revenue reporting migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  let ids: { operator: string; invoice: string };
  const query = (text: string, params: unknown[] = []) =>
    withScratchClient(scratch.url, (c) => c.query(text, params));

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3f_migration',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    ids = await seed(scratch.url);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('captures provider amounts all together, never negative, never cleared once known', async () => {
    const set = (assignments: string) =>
      query(
        `UPDATE "BillingInvoice" SET ${assignments}, "syncedAt" = now() WHERE id = $1`,
        [ids.invoice],
      );
    await expect(set(`"taxMinorUnits" = 100`)).rejects.toThrow();
    await expect(
      set(
        `"subtotalMinorUnits" = 1000, "discountMinorUnits" = -1, "taxMinorUnits" = 100, "totalExcludingTaxMinorUnits" = 1000`,
      ),
    ).rejects.toThrow();
    await expect(set(`"attemptCount" = -1`)).rejects.toThrow();
    await set(
      `"subtotalMinorUnits" = 1000, "discountMinorUnits" = 0, "taxMinorUnits" = 100, "totalExcludingTaxMinorUnits" = 1000, "attemptCount" = 2`,
    );
    // Corrected by a later read: allowed. Cleared: never.
    await set(`"attemptCount" = 3`);
    await expect(
      set(
        `"subtotalMinorUnits" = NULL, "discountMinorUnits" = NULL, "taxMinorUnits" = NULL, "totalExcludingTaxMinorUnits" = NULL`,
      ),
    ).rejects.toThrow();
    await expect(set(`"attemptCount" = NULL`)).rejects.toThrow();
    // The SC3e-1 guard still applies.
    await expect(set(`status = 'open'`)).rejects.toThrow();
  });

  it('knows billing.reports.view; the rollback refuses while it was ever granted', async () => {
    await query(
      `INSERT INTO "PlatformOperatorPermission" (id, "operatorId", permission, "grantReason")
       VALUES (gen_random_uuid()::text, $1, 'billing.reports.view', 'Monthly revenue review.')`,
      [ids.operator],
    );
    await expect(
      query(
        `INSERT INTO "PlatformOperatorPermission" (id, "operatorId", permission, "grantReason")
         VALUES (gen_random_uuid()::text, $1, 'billing.reports.everything', 'Not a permission.')`,
        [ids.operator],
      ),
    ).rejects.toThrow();
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    expect(
      (
        await query(
          `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'BillingInvoice' AND column_name = 'taxMinorUnits'`,
        )
      ).rows[0],
    ).toEqual({ n: 1 });
  });

  it('the rollback restores the SC3e-3 shape exactly when the permission was never granted', async () => {
    const clean = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3f_rollback_clean',
    );
    try {
      await applyMigrations(clean.url, listMigrations(MIGRATIONS));
      const seeded = await seed(clean.url);
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      const columns = await withScratchClient(
        clean.url,
        async (c) =>
          (
            await c.query<{ name: string }>(
              `SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'BillingInvoice'
               AND column_name IN ('subtotalMinorUnits', 'discountMinorUnits', 'taxMinorUnits', 'totalExcludingTaxMinorUnits', 'attemptCount')`,
            )
          ).rows,
      );
      expect(columns).toEqual([]);
      // The permission is unknown again; the invoice guard still holds.
      await expect(
        withScratchClient(clean.url, (c) =>
          c.query(
            `INSERT INTO "PlatformOperatorPermission" (id, "operatorId", permission, "grantReason")
             VALUES (gen_random_uuid()::text, $1, 'billing.reports.view', 'After the rollback.')`,
            [seeded.operator],
          ),
        ),
      ).rejects.toThrow();
      await expect(
        withScratchClient(clean.url, (c) =>
          c.query(`UPDATE "BillingInvoice" SET status = 'open' WHERE id = $1`, [
            seeded.invoice,
          ]),
        ),
      ).rejects.toThrow();
    } finally {
      await clean.drop();
    }
  });
});
