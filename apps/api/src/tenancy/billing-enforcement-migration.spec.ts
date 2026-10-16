import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';
import {
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';

// SC3c-1 — migration 20261027090000_billing_enforcement, on scratch
// databases: the recovery-window policy column (default 3, bounded), the
// subscription's recovery deadline (TRIAL_EXPIRED only), the enforcement
// history types (with their shape rule), and a rollback that restores the
// SC3b shape when no enforcement data exists and refuses, changing nothing,
// once it does.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261027090000_billing_enforcement.down.sql',
);
const THIS = '20261027090000_billing_enforcement';
const FOUNDING_PLAN = '01a0db02-f800-7000-8000-00000000f001';
const OTHER_TENANT = '01a0db02-f800-7000-8000-7e5700003c01';

async function prepare(label: string): Promise<ScratchDatabase> {
  const scratch = await createScratchDatabase(process.env.DATABASE_URL!, label);
  const all = listMigrations(MIGRATIONS);
  const at = all.findIndex((migration) => migration.name === THIS);
  expect(at).toBeGreaterThan(0);
  await applyMigrations(scratch.url, all.slice(0, at + 1));
  return scratch;
}

describe('SC3c-1 billing enforcement migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  let subscriptionId: string;
  const sql = <T>(fn: (client: Client) => Promise<T>) =>
    withScratchClient(scratch.url, fn);
  const expectRefused = (statement: string, params: unknown[] = []) =>
    expect(sql((c) => c.query(statement, params))).rejects.toThrow();

  beforeAll(async () => {
    scratch = await prepare('sc3c_migration');
    subscriptionId = await sql(async (c) => {
      await c.query(
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'sc3c-existing', 'Existing', 'ACTIVE', now())`,
        [OTHER_TENANT],
      );
      const price = (
        await c.query<{ id: string }>(
          `INSERT INTO "SubscriptionPlanPrice" (id, "planId", interval, currency, "amountMinorUnits")
           VALUES (gen_random_uuid()::text, $1, 'MONTH', 'USD', 4900) RETURNING id`,
          [FOUNDING_PLAN],
        )
      ).rows[0].id;
      return (
        await c.query<{ id: string }>(
          `INSERT INTO "TenantSubscription"
             (id, "subscriberTenantId", "planVersionId", "billingMode", "billingProvider",
              "externalCustomerId", "planPriceId", status, "trialStartedAt", "trialEndsAt",
              "trialRequiresPaymentMethod", "updatedAt")
           VALUES (gen_random_uuid()::text, $1, '01a0db02-f800-7000-8000-00000000f002', 'BILLED', 'fake',
              'cus_sc3c', $2, 'TRIALING', now() - interval '14 days', now(), false, now())
           RETURNING id`,
          [OTHER_TENANT, price],
        )
      ).rows[0].id;
    });
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('the policy gets a bounded recovery window, 3 days by default', async () => {
    const [{ days }] = await sql(
      async (c) =>
        (
          await c.query<{ days: number }>(
            `SELECT "trialRecoveryDays" AS days FROM "BillingPolicy" WHERE id = 'default'`,
          )
        ).rows,
    );
    expect(days).toBe(3);
    await expectRefused(
      `UPDATE "BillingPolicy" SET "trialRecoveryDays" = 0 WHERE id = 'default'`,
    );
    await expectRefused(
      `UPDATE "BillingPolicy" SET "trialRecoveryDays" = 15 WHERE id = 'default'`,
    );
  });

  it('a recovery deadline exists only on an expired trial', async () => {
    await expectRefused(
      `UPDATE "TenantSubscription" SET "recoveryEndsAt" = now() + interval '3 days' WHERE id = $1`,
      [subscriptionId],
    );
    await sql((c) =>
      c.query(
        `UPDATE "TenantSubscription" SET status = 'TRIAL_EXPIRED', "recoveryEndsAt" = now() + interval '3 days' WHERE id = $1`,
        [subscriptionId],
      ),
    );
  });

  it('records the enforcement history types, always with the billing status', async () => {
    for (const type of [
      'RECOVERY_EXPIRED',
      'BILLING_SUSPENDED',
      'BILLING_SUSPENSION_LIFTED',
    ]) {
      await sql((c) =>
        c.query(
          `INSERT INTO "TenantSubscriptionEvent" (id, "subscriptionId", type, source, "fromStatus", "toStatus")
           VALUES (gen_random_uuid()::text, $1, $2, 'SYSTEM', 'TRIAL_EXPIRED', 'TRIAL_EXPIRED')`,
          [subscriptionId, type],
        ),
      );
      await expectRefused(
        `INSERT INTO "TenantSubscriptionEvent" (id, "subscriptionId", type, source)
         VALUES (gen_random_uuid()::text, $1, $2, 'SYSTEM')`,
        [subscriptionId, type],
      );
    }
  });

  it('the rollback refuses, changing nothing, once enforcement data exists', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    const [{ count }] = await sql(
      async (c) =>
        (
          await c.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM "TenantSubscriptionEvent" WHERE type::text = 'BILLING_SUSPENDED'`,
          )
        ).rows,
    );
    expect(count).toBe('1');
  });

  it('the rollback restores the SC3b shape when no enforcement data exists', async () => {
    const clean = await prepare('sc3c_rollback_clean');
    try {
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      const columns = await withScratchClient(
        clean.url,
        async (c) =>
          (
            await c.query<{ name: string }>(
              `SELECT column_name AS name FROM information_schema.columns
                WHERE (table_name = 'TenantSubscription' AND column_name = 'recoveryEndsAt')
                   OR (table_name = 'BillingPolicy' AND column_name = 'trialRecoveryDays')`,
            )
          ).rows,
      );
      expect(columns).toEqual([]);
      const values = await withScratchClient(clean.url, async (c) =>
        (
          await c.query<{ value: string }>(
            `SELECT unnest(enum_range(NULL::"TenantSubscriptionEventType"))::text AS value`,
          )
        ).rows.map((r) => r.value),
      );
      expect(values).not.toContain('BILLING_SUSPENDED');
      expect(values).toContain('PLAN_CHANGE_ABANDONED');
    } finally {
      await clean.drop();
    }
  });
});
