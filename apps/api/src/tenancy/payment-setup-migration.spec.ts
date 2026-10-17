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

// SC3e-4 — migration 20261105090000_payment_setup_deadlines, on scratch
// databases: a setup window has a start and a deadline (at most 30 days),
// expires only after its deadline, exists only for a billed business;
// payment setup extensions never pass 30 days; activations are history;
// and a rollback that refuses while any of it exists and otherwise restores
// the SC3e-3 shape.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261105090000_payment_setup_deadlines.down.sql',
);
const TENANT = '01a0db02-f800-7000-8000-7e5700003e04';
const FOUNDING_VERSION = '01a0db02-f800-7000-8000-00000000f002';

jest.setTimeout(120_000);

describe('SC3e-4 payment setup migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  let subscriptionId: string;
  const query = (text: string, params: unknown[] = []) =>
    withScratchClient(scratch.url, (c) =>
      c.query<Record<string, unknown> & { id: string }>(text, params),
    );
  const setWindow = (sql: string) =>
    query(`UPDATE "TenantSubscription" SET ${sql} WHERE id = $1`, [
      subscriptionId,
    ]);

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3e4_migration',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    await query(
      `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'sc3e4-mig', 'Mig', 'ACTIVE', now())`,
      [TENANT],
    );
    subscriptionId = (
      await query(
        `INSERT INTO "TenantSubscription" (id, "subscriberTenantId", "planVersionId", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, now()) RETURNING id`,
        [TENANT, FOUNDING_VERSION],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('keeps the setup window consistent', async () => {
    // A complimentary business never has payment setup state.
    await expect(
      setWindow(`"paymentSetupRequiredSince" = now()`),
    ).rejects.toThrow();
    // Billed (a plan price of its own).
    const plan = (
      await query(
        `INSERT INTO "SubscriptionPlan" (id, key, name, "updatedAt") VALUES (gen_random_uuid()::text, 'sc3e4-mig', 'Mig', now()) RETURNING id`,
      )
    ).rows[0].id;
    const price = (
      await query(
        `INSERT INTO "SubscriptionPlanPrice" (id, "planId", interval, currency, "amountMinorUnits")
         VALUES (gen_random_uuid()::text, $1, 'MONTH', 'USD', 4900) RETURNING id`,
        [plan],
      )
    ).rows[0].id;
    await query(
      `UPDATE "TenantSubscription" SET "billingMode" = 'BILLED', "billingProvider" = 'fake',
         "externalCustomerId" = 'cus_mig', "planPriceId" = $2 WHERE id = $1`,
      [subscriptionId, price],
    );
    await setWindow(`"paymentSetupRequiredSince" = now()`);
    // A deadline without a start, past 30 days, or an expiry before it: refused.
    await expect(
      setWindow(`"paymentSetupDueAt" = now() + interval '14 days'`),
    ).rejects.toThrow();
    await expect(
      setWindow(
        `"paymentSetupWindowStartedAt" = now(), "paymentSetupDueAt" = now() + interval '31 days'`,
      ),
    ).rejects.toThrow();
    await setWindow(
      `"paymentSetupWindowStartedAt" = now(), "paymentSetupDueAt" = now() + interval '14 days'`,
    );
    await expect(
      setWindow(`"paymentSetupExpiredAt" = now()`),
    ).rejects.toThrow();
    await setWindow(
      `"paymentSetupDueAt" = "paymentSetupWindowStartedAt" + interval '30 days'`,
    );
    // Never back to complimentary with payment setup state left over.
    await expect(
      setWindow(`"billingMode" = 'COMPLIMENTARY', "billingProvider" = NULL`),
    ).rejects.toThrow();
    // A payment setup extension past 30 days from its window's start: refused.
    const operator = (
      await query(
        `INSERT INTO "PlatformOperator" (id, "externalProvider", "externalSubject", email, status, "updatedAt")
         VALUES (gen_random_uuid()::text, 'platform-dev', 'platform-dev:sc3e4-mig', 'sc3e4-mig@example.test', 'ACTIVE', now()) RETURNING id`,
      )
    ).rows[0].id;
    const extension = (days: number, newEndsDays: number) =>
      query(
        `INSERT INTO "BillingGraceExtension" (id, "subscriptionId", kind, "episodeStartedAt", days, "previousEndsAt", "newEndsAt", reason, "actorPlatformOperatorId")
         VALUES (gen_random_uuid()::text, $1, 'PAYMENT_SETUP', now(), $2, now() + interval '14 days', now() + make_interval(days => $3), 'Owner needs more time.', $4)`,
        [subscriptionId, days, newEndsDays, operator],
      );
    await expect(extension(14, 31)).rejects.toThrow();
    await extension(14, 28);
  });

  it('activations are history: never removed, their start never changed', async () => {
    const id = (
      await query(
        `INSERT INTO "BillingEnforcementActivation" (id) VALUES (gen_random_uuid()::text) RETURNING id`,
      )
    ).rows[0].id;
    await query(
      `UPDATE "BillingEnforcementActivation" SET "lastSweepAt" = now() + interval '1 hour' WHERE id = $1`,
      [id],
    );
    await expect(
      query(
        `UPDATE "BillingEnforcementActivation" SET "startedAt" = now() - interval '1 day' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow();
    await expect(
      query(
        `UPDATE "BillingEnforcementActivation" SET "lastSweepAt" = "startedAt" WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow();
    await expect(
      query(`DELETE FROM "BillingEnforcementActivation" WHERE id = $1`, [id]),
    ).rejects.toThrow();
  });

  it('the rollback refuses while any of it exists', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    expect(
      (
        await query(
          `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'BillingEnforcementActivation'`,
        )
      ).rows[0],
    ).toEqual({ n: 1 });
  });

  it('the rollback restores the SC3e-3 shape exactly when nothing exists', async () => {
    const clean = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3e4_rollback_clean',
    );
    try {
      await applyMigrations(clean.url, listMigrations(MIGRATIONS));
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      const left = await withScratchClient(clean.url, async (c) => ({
        objects: (
          await c.query<{ name: string }>(
            `SELECT table_name AS name FROM information_schema.tables WHERE table_name = 'BillingEnforcementActivation'
             UNION ALL
             SELECT column_name FROM information_schema.columns WHERE table_name = 'TenantSubscription'
               AND column_name LIKE 'paymentSetup%'
             UNION ALL
             SELECT proname FROM pg_proc WHERE proname = 'guard_billing_enforcement_activation'`,
          )
        ).rows,
        enumValues: (
          await c.query<{ v: string }>(
            `SELECT unnest(enum_range(NULL::"TenantSubscriptionEventType"))::text AS v`,
          )
        ).rows
          .map((r) => r.v)
          .filter((v) => v.startsWith('PAYMENT_SETUP')),
      }));
      expect(left).toEqual({ objects: [], enumValues: [] });
    } finally {
      await clean.drop();
    }
  });
});
