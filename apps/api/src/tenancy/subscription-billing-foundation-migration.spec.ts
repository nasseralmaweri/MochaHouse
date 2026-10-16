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

// SC3a — migration 20261025090000_subscription_billing_foundation, on
// scratch databases holding SC2a data (Founding subscriptions with their
// history, an add-on, a business on another plan):
//   * every existing subscription becomes COMPLIMENTARY and keeps its plan,
//     status, add-ons and history (history source OPERATOR);
//   * the rebuilt enums keep every existing value;
//   * the default billing policy is created (14-day trial with a payment
//     method, 14 days of grace);
//   * the documented rollback restores the SC2a shape when no billing data
//     exists, and refuses (changing nothing) once it does.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261025090000_subscription_billing_foundation.down.sql',
);
const THIS = '20261025090000_subscription_billing_foundation';
const OTHER_TENANT = '01a0db02-f800-7000-8000-7e5700003a01';

async function prepare(label: string): Promise<ScratchDatabase> {
  const scratch = await createScratchDatabase(process.env.DATABASE_URL!, label);
  const all = listMigrations(MIGRATIONS);
  const at = all.findIndex((migration) => migration.name === THIS);
  expect(at).toBeGreaterThan(0);
  await applyMigrations(scratch.url, all.slice(0, at));
  // SC2a data: a second business with an add-on and an operator change.
  await withScratchClient(scratch.url, async (c) => {
    await c.query(
      `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'sc3a-existing', 'Existing', 'ACTIVE', now())`,
      [OTHER_TENANT],
    );
    await c.query(
      `INSERT INTO "TenantSubscription" (id, "subscriberTenantId", "planVersionId", status, "updatedAt")
       VALUES (gen_random_uuid()::text, $1, '01a0db02-f800-7000-8000-00000000f002', 'TRIALING', now())`,
      [OTHER_TENANT],
    );
    await c.query(
      `INSERT INTO "TenantModuleGrant" (id, "subscriptionId", "moduleKey")
       SELECT gen_random_uuid()::text, id, 'crm' FROM "TenantSubscription" WHERE "subscriberTenantId" = $1`,
      [OTHER_TENANT],
    );
    await c.query(
      `INSERT INTO "TenantSubscriptionEvent" (id, "subscriptionId", type, "moduleKey")
       SELECT gen_random_uuid()::text, id, 'ADDON_GRANTED', 'crm' FROM "TenantSubscription" WHERE "subscriberTenantId" = $1`,
      [OTHER_TENANT],
    );
  });
  await applyMigrations(scratch.url, [all[at]]);
  return scratch;
}

describe('SC3a subscription billing foundation migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  const sql = <T>(fn: (client: Client) => Promise<T>) =>
    withScratchClient(scratch.url, fn);

  beforeAll(async () => {
    scratch = await prepare('sc3a_migration');
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('keeps every existing subscription exactly as it was, now COMPLIMENTARY, never billed', async () => {
    const rows = await sql(
      async (c) =>
        (
          await c.query<{
            tenant: string;
            mode: string;
            status: string;
            provider: string | null;
            price: string | null;
            grants: string;
          }>(
            `SELECT s."subscriberTenantId" AS tenant, s."billingMode"::text AS mode, s.status::text AS status,
                    s."billingProvider" AS provider, s."planPriceId" AS price,
                    (SELECT count(*) FROM "TenantModuleGrant" g WHERE g."subscriptionId" = s.id)::text AS grants
               FROM "TenantSubscription" s ORDER BY s."subscriberTenantId"`,
          )
        ).rows,
    );
    expect(rows).toEqual(
      [
        {
          tenant: TENANT_1_MOCHA_HOUSE_ID,
          mode: 'COMPLIMENTARY',
          status: 'ACTIVE',
          provider: null,
          price: null,
          grants: '0',
        },
        {
          tenant: OTHER_TENANT,
          mode: 'COMPLIMENTARY',
          status: 'TRIALING',
          provider: null,
          price: null,
          grants: '1',
        },
      ].sort((a, b) => a.tenant.localeCompare(b.tenant)),
    );
    const history = await sql(
      async (c) =>
        (
          await c.query<{ type: string; source: string }>(
            `SELECT type::text AS type, source::text AS source FROM "TenantSubscriptionEvent" ORDER BY type`,
          )
        ).rows,
    );
    expect(history).toEqual(
      expect.arrayContaining([
        { type: 'ADDON_GRANTED', source: 'OPERATOR' },
        { type: 'PLAN_ASSIGNED', source: 'OPERATOR' },
      ]),
    );
  });

  it('creates the default billing policy and the billing tables empty', async () => {
    const policy = await sql(
      async (c) =>
        (
          await c.query<{
            trialDays: number;
            trialRequiresPaymentMethod: boolean;
            gracePeriodDays: number;
          }>(
            `SELECT "trialDays", "trialRequiresPaymentMethod", "gracePeriodDays" FROM "BillingPolicy" WHERE id = 'default'`,
          )
        ).rows,
    );
    expect(policy).toEqual([
      { trialDays: 14, trialRequiresPaymentMethod: true, gracePeriodDays: 14 },
    ]);
    for (const table of [
      'SubscriptionPlanPrice',
      'BillingTrialClaim',
      'BillingProviderEvent',
    ]) {
      const [{ count }] = await sql(
        async (c) =>
          (
            await c.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM "${table}"`,
            )
          ).rows,
      );
      expect(count).toBe('0');
    }
  });

  it('keeps history append-only and the new event shapes checked', async () => {
    await expect(
      sql((c) => c.query(`DELETE FROM "TenantSubscriptionEvent"`)),
    ).rejects.toThrow(/append-only/);
    await expect(
      sql((c) =>
        c.query(
          `INSERT INTO "TenantSubscriptionEvent" (id, "subscriptionId", type, source)
           SELECT gen_random_uuid()::text, id, 'PAYMENT_FAILED', 'BILLING_PROVIDER' FROM "TenantSubscription" LIMIT 1`,
        ),
      ),
    ).rejects.toThrow(/shape_check/);
  });

  it('the rollback restores the SC2a shape while no billing data exists', async () => {
    const clean = await prepare('sc3a_rollback_clean');
    try {
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      const columns = await withScratchClient(clean.url, async (c) =>
        (
          await c.query<{ name: string }>(
            `SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'TenantSubscription' ORDER BY column_name`,
          )
        ).rows.map((r) => r.name),
      );
      expect(columns).not.toContain('billingMode');
      const statuses = await withScratchClient(clean.url, async (c) =>
        (
          await c.query<{ v: string }>(
            `SELECT unnest(enum_range(NULL::"TenantSubscriptionStatus"))::text AS v`,
          )
        ).rows.map((r) => r.v),
      );
      expect(statuses).toEqual(['ACTIVE', 'TRIALING']);
      const tables = await withScratchClient(
        clean.url,
        async (c) =>
          (
            await c.query<{ t: string | null }>(
              `SELECT to_regclass('"BillingProviderEvent"') AS t`,
            )
          ).rows,
      );
      expect(tables).toEqual([{ t: null }]);
    } finally {
      await clean.drop();
    }
  });

  it('the rollback refuses, changing nothing, once billing data exists', async () => {
    await sql((c) =>
      c.query(
        `INSERT INTO "SubscriptionPlanPrice" (id, "planId", interval, currency, "amountMinorUnits")
         VALUES (gen_random_uuid()::text, '01a0db02-f800-7000-8000-00000000f001', 'MONTH', 'USD', 4900)`,
      ),
    );
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    const [{ count }] = await sql(
      async (c) =>
        (
          await c.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM "SubscriptionPlanPrice"`,
          )
        ).rows,
    );
    expect(count).toBe('1');
  });
});
