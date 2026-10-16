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

// SC3d-1 — migration 20261030090000_plan_changes, on scratch databases: a
// strict plan-change shape (an immediate change always carries the
// provider's preview and proration date), at most one open change per
// subscription, previewed values that never change, no deletion, final
// finished changes, and a rollback that refuses while any change exists.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261030090000_plan_changes.down.sql',
);
const THIS = '20261030090000_plan_changes';
const FOUNDING_PLAN = '01a0db02-f800-7000-8000-00000000f001';
const FOUNDING_VERSION = '01a0db02-f800-7000-8000-00000000f002';
const TENANT = '01a0db02-f800-7000-8000-7e5700003d1a';

jest.setTimeout(120_000);

describe('SC3d-1 plan changes migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  let subscriptionId: string;
  let fromPrice: string;
  let toPrice: string;
  const sql = <T>(fn: (client: Client) => Promise<T>) =>
    withScratchClient(scratch.url, fn);
  const query = (text: string, params: unknown[] = []) =>
    sql((c) => c.query<Record<string, unknown>>(text, params));
  const expectRefused = (statement: string, params: unknown[] = []) =>
    expect(query(statement, params)).rejects.toThrow();
  const change = (over: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      timing: 'IMMEDIATE',
      status: 'PREVIEWED',
      amountDue: 1200,
      prorationDate: new Date(),
      itemId: 'si_1',
      actorKind: 'STAFF',
      finishedAt: null,
      toPrice,
      ...over,
    };
    return query(
      `INSERT INTO "BillingPlanChange"
         (id, "subscriptionId", timing, status, "fromPlanVersionId", "fromPlanPriceId",
          "toPlanVersionId", "toPlanPriceId", currency, "previewAmountDueMinorUnits",
          "prorationDate", "externalItemId", "nextRecurringMinorUnits", "previewExpiresAt",
          "actorKind", "finishedAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $4, $6, 'USD', $7, $8, $9, 9900,
               now() + interval '10 minutes', $10, $11, now())
       RETURNING id`,
      [
        subscriptionId,
        row.timing,
        row.status,
        FOUNDING_VERSION,
        fromPrice,
        row.toPrice,
        row.amountDue,
        row.prorationDate,
        row.itemId,
        row.actorKind,
        row.finishedAt,
      ],
    );
  };

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3d1_migration',
    );
    const all = listMigrations(MIGRATIONS);
    const at = all.findIndex((migration) => migration.name === THIS);
    expect(at).toBeGreaterThan(0);
    await applyMigrations(scratch.url, all.slice(0, at));
    await sql(async (c) => {
      await c.query(
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'sc3d1-mig', 'Mig', 'ACTIVE', now())`,
        [TENANT],
      );
      subscriptionId = (
        await c.query<{ id: string }>(
          `INSERT INTO "TenantSubscription" (id, "subscriberTenantId", "planVersionId", "updatedAt")
           VALUES (gen_random_uuid()::text, $1, $2, now()) RETURNING id`,
          [TENANT, FOUNDING_VERSION],
        )
      ).rows[0].id;
      const price = async (amount: number, interval: string) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO "SubscriptionPlanPrice" (id, "planId", interval, currency, "amountMinorUnits")
             VALUES (gen_random_uuid()::text, $1, $3, 'USD', $2) RETURNING id`,
            [FOUNDING_PLAN, amount, interval],
          )
        ).rows[0].id;
      fromPrice = await price(4900, 'MONTH');
      toPrice = await price(49000, 'YEAR');
    });
    const before = await query(
      `SELECT count(*)::int AS n FROM "TenantSubscription"`,
    );
    await applyMigrations(scratch.url, [all[at]]);
    expect(
      (await query(`SELECT count(*)::int AS n FROM "TenantSubscription"`)).rows,
    ).toEqual(before.rows);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('an immediate change carries the preview and proration date; the others charge nothing now', async () => {
    await change();
    await expect(change({ amountDue: null })).rejects.toThrow();
    await expect(change({ prorationDate: null })).rejects.toThrow();
    await expect(change({ itemId: null })).rejects.toThrow();
    await expect(change({ timing: 'PERIOD_END' })).rejects.toThrow();
    await change({
      timing: 'PERIOD_END',
      amountDue: null,
      prorationDate: null,
      itemId: null,
    });
    await expect(change({ toPrice: fromPrice })).rejects.toThrow();
    await expect(change({ timing: 'SOMETIME' })).rejects.toThrow();
    await expect(change({ status: 'APPLIED' })).rejects.toThrow();
    await expect(change({ actorKind: 'OPERATOR' })).rejects.toThrow();
  });

  it('at most one open change per subscription; previews never block', async () => {
    await change({ status: 'REQUESTED' });
    await expect(change({ status: 'SCHEDULED' })).rejects.toThrow();
    await change();
  });

  it('what was previewed never changes; never deleted; a finished change is final', async () => {
    const id = String((await change()).rows[0].id);
    await expectRefused(
      `UPDATE "BillingPlanChange" SET "previewAmountDueMinorUnits" = 1 WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingPlanChange" SET "prorationDate" = now() WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingPlanChange" SET "toPlanPriceId" = $2 WHERE id = $1`,
      [id, fromPrice],
    );
    await expectRefused(`DELETE FROM "BillingPlanChange" WHERE id = $1`, [id]);
    await expectRefused(`TRUNCATE "BillingPlanChange"`);
    await query(
      `UPDATE "BillingPlanChange" SET "externalInvoiceId" = 'in_1' WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingPlanChange" SET "externalInvoiceId" = 'in_2' WHERE id = $1`,
      [id],
    );
    await query(
      `UPDATE "BillingPlanChange" SET status = 'EXPIRED', "finishedAt" = now() WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingPlanChange" SET "failureCode" = 'LATER' WHERE id = $1`,
      [id],
    );
  });

  it('a change only moves forward, and what was paid is set once', async () => {
    const skip = String((await change()).rows[0].id);
    await expectRefused(
      `UPDATE "BillingPlanChange" SET status = 'APPLIED', "finishedAt" = now() WHERE id = $1`,
      [skip],
    );
    await expectRefused(
      `UPDATE "BillingPlanChange" SET status = 'SCHEDULED' WHERE id = $1`,
      [skip],
    );
    await query(
      `UPDATE "BillingPlanChange" SET status = 'EXPIRED', "finishedAt" = now() WHERE id = $1`,
      [skip],
    );
    const id = String(
      (
        await change({
          timing: 'PERIOD_END',
          amountDue: null,
          prorationDate: null,
          itemId: null,
        })
      ).rows[0].id,
    );
    // (the one-open slot is held by the earlier REQUESTED row)
    await query(
      `UPDATE "BillingPlanChange" SET status = 'CANCELED', "finishedAt" = now() WHERE status = 'REQUESTED'`,
    );
    await query(
      `UPDATE "BillingPlanChange" SET status = 'REQUESTED' WHERE id = $1`,
      [id],
    );
    await query(
      `UPDATE "BillingPlanChange" SET status = 'AWAITING_PAYMENT', "amountPaidMinorUnits" = 100 WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingPlanChange" SET "amountPaidMinorUnits" = 200 WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingPlanChange" SET status = 'REQUESTED' WHERE id = $1`,
      [id],
    );
    await query(
      `UPDATE "BillingPlanChange" SET status = 'APPLIED', "finishedAt" = now() WHERE id = $1`,
      [id],
    );
  });

  it('the rollback refuses, changing nothing, while any change exists', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    expect(
      Number(
        (await query(`SELECT count(*)::int AS n FROM "BillingPlanChange"`))
          .rows[0].n,
      ),
    ).toBeGreaterThan(0);
  });

  it('the rollback removes exactly the table and its guard when no change exists', async () => {
    const clean = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3d1_rollback_clean',
    );
    try {
      await applyMigrations(clean.url, listMigrations(MIGRATIONS));
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      const left = await withScratchClient(
        clean.url,
        async (c) =>
          (
            await c.query<{ name: string }>(
              `SELECT table_name AS name FROM information_schema.tables WHERE table_name = 'BillingPlanChange'
             UNION ALL
             SELECT proname FROM pg_proc WHERE proname = 'guard_billing_plan_change'`,
            )
          ).rows,
      );
      expect(left).toEqual([]);
    } finally {
      await clean.drop();
    }
  });
});
