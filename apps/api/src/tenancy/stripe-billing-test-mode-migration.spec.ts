import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';

// SC3b — migration 20261026090000_stripe_billing_test_mode, on scratch
// databases holding SC3a data:
//   * existing (COMPLIMENTARY) subscriptions are unaffected;
//   * a BILLED subscription may now have its provider customer before its
//     provider subscription, and always has a customer and an agreed price;
//   * one OPEN Checkout per subscription; one OPEN case per subject and kind;
//     provider ids set once; rows never deleted;
//   * the rollback restores the SC3a shape when no Stripe data exists and
//     refuses, changing nothing, once it does.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261026090000_stripe_billing_test_mode.down.sql',
);
const THIS = '20261026090000_stripe_billing_test_mode';
const FOUNDING_PLAN = '01a0db02-f800-7000-8000-00000000f001';
const OTHER_TENANT = '01a0db02-f800-7000-8000-7e5700003b01';

async function prepare(label: string): Promise<ScratchDatabase> {
  const scratch = await createScratchDatabase(process.env.DATABASE_URL!, label);
  const all = listMigrations(MIGRATIONS);
  const at = all.findIndex((migration) => migration.name === THIS);
  expect(at).toBeGreaterThan(0);
  await applyMigrations(scratch.url, all.slice(0, at + 1));
  return scratch;
}

describe('SC3b Stripe billing (test mode) migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  let priceId: string;
  let subscriptionId: string;
  const sql = <T>(fn: (client: Client) => Promise<T>) =>
    withScratchClient(scratch.url, fn);
  const expectRefused = (statement: string, params: unknown[] = []) =>
    expect(sql((c) => c.query(statement, params))).rejects.toThrow();

  beforeAll(async () => {
    scratch = await prepare('sc3b_migration');
    await sql(async (c) => {
      await c.query(
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'sc3b-existing', 'Existing', 'ACTIVE', now())`,
        [OTHER_TENANT],
      );
      await c.query(
        `INSERT INTO "TenantSubscription" (id, "subscriberTenantId", "planVersionId", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, '01a0db02-f800-7000-8000-00000000f002', now())`,
        [OTHER_TENANT],
      );
      priceId = (
        await c.query<{ id: string }>(
          `INSERT INTO "SubscriptionPlanPrice" (id, "planId", interval, currency, "amountMinorUnits")
           VALUES (gen_random_uuid()::text, $1, 'MONTH', 'USD', 4900) RETURNING id`,
          [FOUNDING_PLAN],
        )
      ).rows[0].id;
      subscriptionId = (
        await c.query<{ id: string }>(
          `SELECT id FROM "TenantSubscription" WHERE "subscriberTenantId" = $1`,
          [OTHER_TENANT],
        )
      ).rows[0].id;
    });
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('leaves existing complimentary subscriptions exactly as they were', async () => {
    const rows = await sql(
      async (c) =>
        (
          await c.query<{ tenant: string; mode: string }>(
            `SELECT "subscriberTenantId" AS tenant, "billingMode"::text AS mode FROM "TenantSubscription" ORDER BY 1`,
          )
        ).rows,
    );
    expect(rows).toEqual(
      [TENANT_1_MOCHA_HOUSE_ID, OTHER_TENANT]
        .sort()
        .map((tenant) => ({ tenant, mode: 'COMPLIMENTARY' })),
    );
  });

  it('a billed subscription has its customer and agreed price; the customer may come before the provider subscription', async () => {
    await expectRefused(
      `UPDATE "TenantSubscription" SET "billingMode" = 'BILLED', "billingProvider" = 'stripe' WHERE id = $1`,
      [subscriptionId],
    );
    await expectRefused(
      `UPDATE "TenantSubscription" SET "externalCustomerId" = 'cus_x' WHERE id = $1`,
      [subscriptionId],
    );
    await sql((c) =>
      c.query(
        `UPDATE "TenantSubscription"
            SET "billingMode" = 'BILLED', "billingProvider" = 'stripe', "externalCustomerId" = 'cus_1', "planPriceId" = $2
          WHERE id = $1`,
        [subscriptionId, priceId],
      ),
    );
  });

  it('allows ONE open Checkout per subscription and keeps sessions undeletable and set-once', async () => {
    const insert = () =>
      sql((c) =>
        c.query<{ id: string }>(
          `INSERT INTO "BillingCheckoutSession" (id, "subscriptionId", "planPriceId", "trialDays", "requiresPaymentMethod")
           VALUES (gen_random_uuid()::text, $1, $2, 14, false) RETURNING id`,
          [subscriptionId, priceId],
        ),
      );
    const id = (await insert()).rows[0].id;
    await expect(insert()).rejects.toThrow();
    await sql((c) =>
      c.query(
        `UPDATE "BillingCheckoutSession" SET "externalSessionId" = 'cs_1' WHERE id = $1`,
        [id],
      ),
    );
    await expectRefused(
      `UPDATE "BillingCheckoutSession" SET "externalSessionId" = 'cs_2' WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingCheckoutSession" SET "trialDays" = 30 WHERE id = $1`,
      [id],
    );
    await sql((c) =>
      c.query(
        `UPDATE "BillingCheckoutSession" SET status = 'COMPLETED', "completedAt" = now() WHERE id = $1`,
        [id],
      ),
    );
    await expectRefused(
      `UPDATE "BillingCheckoutSession" SET status = 'EXPIRED', "completedAt" = NULL WHERE id = $1`,
      [id],
    );
    await expectRefused(`DELETE FROM "BillingCheckoutSession" WHERE id = $1`, [
      id,
    ]);
    // Completed: a new one may open.
    await insert();
  });

  it('keeps one open case per subject and kind; a case is resolved once and never deleted', async () => {
    const open = () =>
      sql((c) =>
        c.query<{ id: string }>(
          `INSERT INTO "BillingReconciliationCase" (id, kind, "subscriptionId") VALUES (gen_random_uuid()::text, 'STATE_MISMATCH', $1) RETURNING id`,
          [subscriptionId],
        ),
      );
    const id = (await open()).rows[0].id;
    await expect(open()).rejects.toThrow();
    await expectRefused(
      `INSERT INTO "BillingReconciliationCase" (id, kind) VALUES (gen_random_uuid()::text, 'STATE_MISMATCH')`,
    );
    await sql((c) =>
      c.query(
        `UPDATE "BillingReconciliationCase" SET status = 'RESOLVED', "resolvedAt" = now() WHERE id = $1`,
        [id],
      ),
    );
    await expectRefused(
      `UPDATE "BillingReconciliationCase" SET status = 'OPEN', "resolvedAt" = NULL WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `DELETE FROM "BillingReconciliationCase" WHERE id = $1`,
      [id],
    );
  });

  it('records a plan product id once', async () => {
    await sql((c) =>
      c.query(
        `UPDATE "SubscriptionPlan" SET "externalProductId" = 'prod_1' WHERE id = $1`,
        [FOUNDING_PLAN],
      ),
    );
    await expectRefused(
      `UPDATE "SubscriptionPlan" SET "externalProductId" = 'prod_2' WHERE id = $1`,
      [FOUNDING_PLAN],
    );
  });

  it('the rollback refuses, changing nothing, once Stripe billing data exists', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    const [{ count }] = await sql(
      async (c) =>
        (
          await c.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM "BillingCheckoutSession"`,
          )
        ).rows,
    );
    expect(count).toBe('2');
  });

  it('the rollback restores the SC3a shape when no Stripe billing data exists', async () => {
    const clean = await prepare('sc3b_rollback_clean');
    try {
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      const tables = await withScratchClient(
        clean.url,
        async (c) =>
          (
            await c.query<{ checkout: string | null; cases: string | null }>(
              `SELECT to_regclass('"BillingCheckoutSession"')::text AS checkout, to_regclass('"BillingReconciliationCase"')::text AS cases`,
            )
          ).rows,
      );
      expect(tables).toEqual([{ checkout: null, cases: null }]);
      const column = await withScratchClient(
        clean.url,
        async (c) =>
          (
            await c.query<{ name: string }>(
              `SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'SubscriptionPlan' AND column_name = 'externalProductId'`,
            )
          ).rows,
      );
      expect(column).toEqual([]);
    } finally {
      await clean.drop();
    }
  });
});
