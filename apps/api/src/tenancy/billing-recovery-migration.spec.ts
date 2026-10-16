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

// SC3c-2 — migration 20261028090000_billing_recovery, on scratch databases:
// a restart Checkout records the subscription it replaces (never with a
// trial; set once; one COMPLETED replacement per replaced subscription),
// the SUBSCRIPTION_REPLACED history type, and a rollback that restores the
// SC3c-1 shape when no recovery data exists and refuses, changing nothing,
// once it does.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261028090000_billing_recovery.down.sql',
);
const THIS = '20261028090000_billing_recovery';
const FOUNDING_PLAN = '01a0db02-f800-7000-8000-00000000f001';
const OTHER_TENANT = '01a0db02-f800-7000-8000-7e5700003c02';

async function prepare(label: string): Promise<ScratchDatabase> {
  const scratch = await createScratchDatabase(process.env.DATABASE_URL!, label);
  const all = listMigrations(MIGRATIONS);
  const at = all.findIndex((migration) => migration.name === THIS);
  expect(at).toBeGreaterThan(0);
  await applyMigrations(scratch.url, all.slice(0, at + 1));
  return scratch;
}

describe('SC3c-2 billing recovery migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  let subscriptionId: string;
  let priceId: string;
  const sql = <T>(fn: (client: Client) => Promise<T>) =>
    withScratchClient(scratch.url, fn);
  const expectRefused = (statement: string, params: unknown[] = []) =>
    expect(sql((c) => c.query(statement, params))).rejects.toThrow();
  const checkout = (replaces: string | null, trialDays = 0) =>
    sql((c) =>
      c.query<{ id: string }>(
        `INSERT INTO "BillingCheckoutSession"
           (id, "subscriptionId", "planPriceId", "trialDays", "requiresPaymentMethod", "trialClaimKey", "replacesExternalSubscriptionId")
         VALUES (gen_random_uuid()::text, $1, $2, $3, true, $4, $5) RETURNING id`,
        [
          subscriptionId,
          priceId,
          trialDays,
          trialDays > 0 ? 'a'.repeat(64) : null,
          replaces,
        ],
      ),
    );
  const complete = (id: string) =>
    sql((c) =>
      c.query(
        `UPDATE "BillingCheckoutSession" SET "externalSessionId" = $2, status = 'COMPLETED', "completedAt" = now() WHERE id = $1`,
        [id, `cs_${id}`],
      ),
    );

  beforeAll(async () => {
    scratch = await prepare('sc3c2_migration');
    await sql(async (c) => {
      await c.query(
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'sc3c2-existing', 'Existing', 'ACTIVE', now())`,
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
          `INSERT INTO "TenantSubscription" (id, "subscriberTenantId", "planVersionId", "updatedAt")
           VALUES (gen_random_uuid()::text, $1, '01a0db02-f800-7000-8000-00000000f002', now()) RETURNING id`,
          [OTHER_TENANT],
        )
      ).rows[0].id;
    });
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('a restart Checkout never offers a trial, and what it replaces is set once', async () => {
    await expect(checkout('sub_old', 14)).rejects.toThrow();
    const id = (await checkout('sub_old')).rows[0].id;
    await expectRefused(
      `UPDATE "BillingCheckoutSession" SET "replacesExternalSubscriptionId" = 'sub_other' WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingCheckoutSession" SET "replacesExternalSubscriptionId" = NULL WHERE id = $1`,
      [id],
    );
    await complete(id);
  });

  it('at most one COMPLETED replacement per replaced subscription', async () => {
    const second = (await checkout('sub_old')).rows[0].id;
    await expect(complete(second)).rejects.toThrow();
    await sql((c) =>
      c.query(
        `UPDATE "BillingCheckoutSession" SET status = 'EXPIRED' WHERE id = $1`,
        [second],
      ),
    );
  });

  it('records SUBSCRIPTION_REPLACED with the billing status', async () => {
    await sql((c) =>
      c.query(
        `INSERT INTO "TenantSubscriptionEvent" (id, "subscriptionId", type, source, "fromStatus", "toStatus")
         VALUES (gen_random_uuid()::text, $1, 'SUBSCRIPTION_REPLACED', 'SYSTEM', 'CANCELED', 'ACTIVE')`,
        [subscriptionId],
      ),
    );
    await expectRefused(
      `INSERT INTO "TenantSubscriptionEvent" (id, "subscriptionId", type, source)
       VALUES (gen_random_uuid()::text, $1, 'SUBSCRIPTION_REPLACED', 'SYSTEM')`,
      [subscriptionId],
    );
  });

  it('the rollback refuses, changing nothing, once recovery data exists', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    const [{ count }] = await sql(
      async (c) =>
        (
          await c.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM "BillingCheckoutSession" WHERE "replacesExternalSubscriptionId" IS NOT NULL`,
          )
        ).rows,
    );
    expect(count).toBe('2');
  });

  it('the rollback restores the SC3c-1 shape when no recovery data exists', async () => {
    const clean = await prepare('sc3c2_rollback_clean');
    try {
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      const columns = await withScratchClient(
        clean.url,
        async (c) =>
          (
            await c.query<{ name: string }>(
              `SELECT column_name AS name FROM information_schema.columns
                WHERE table_name = 'BillingCheckoutSession' AND column_name = 'replacesExternalSubscriptionId'`,
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
      expect(values).not.toContain('SUBSCRIPTION_REPLACED');
      expect(values).toContain('BILLING_SUSPENSION_LIFTED');
    } finally {
      await clean.drop();
    }
  });
});
