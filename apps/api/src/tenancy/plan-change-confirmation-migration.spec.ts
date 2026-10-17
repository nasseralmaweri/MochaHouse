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

// SC3d-2 — migration 20261031090000_plan_change_confirmation: applied over
// existing previews (unchanged), a confirmation time required for every
// confirmed state and set once, an operator reason only on operator rows
// and never changed, and a rollback that refuses once any change was
// confirmed or carries a reason.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261031090000_plan_change_confirmation.down.sql',
);
const THIS = '20261031090000_plan_change_confirmation';
const FOUNDING_PLAN = '01a0db02-f800-7000-8000-00000000f001';
const FOUNDING_VERSION = '01a0db02-f800-7000-8000-00000000f002';
const TENANT = '01a0db02-f800-7000-8000-7e5700003d2a';

jest.setTimeout(120_000);

describe('SC3d-2 plan change confirmation migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  let subscriptionId: string;
  let fromPrice: string;
  let toPrice: string;
  let operatorId: string;
  let existing: string;
  const sql = <T>(fn: (client: Client) => Promise<T>) =>
    withScratchClient(scratch.url, fn);
  const query = (text: string, params: unknown[] = []) =>
    sql((c) => c.query<Record<string, unknown>>(text, params));
  const expectRefused = (statement: string, params: unknown[] = []) =>
    expect(query(statement, params)).rejects.toThrow();
  const preview = async (
    actor: 'STAFF' | 'OPERATOR' = 'STAFF',
    reason: string | null = null,
  ) =>
    String(
      (
        await query(
          `INSERT INTO "BillingPlanChange"
             (id, "subscriptionId", timing, "fromPlanVersionId", "fromPlanPriceId", "toPlanVersionId",
              "toPlanPriceId", currency, "previewAmountDueMinorUnits", "prorationDate", "externalItemId",
              "nextRecurringMinorUnits", "previewExpiresAt", "actorKind", "actorPlatformOperatorId",
              ${reason === null ? '' : '"operatorReason",'} "updatedAt")
           VALUES (gen_random_uuid()::text, $1, 'IMMEDIATE', $2, $3, $2, $4, 'USD', 1200, now(), 'si_1',
                   9900, now() + interval '10 minutes', $5, $6, ${reason === null ? '' : '$7,'} now())
           RETURNING id`,
          [
            subscriptionId,
            FOUNDING_VERSION,
            fromPrice,
            toPrice,
            actor,
            actor === 'OPERATOR' ? operatorId : null,
            ...(reason === null ? [] : [reason]),
          ],
        )
      ).rows[0].id,
    );

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3d2_migration',
    );
    const all = listMigrations(MIGRATIONS);
    const at = all.findIndex((migration) => migration.name === THIS);
    expect(at).toBeGreaterThan(0);
    await applyMigrations(scratch.url, all.slice(0, at));
    await sql(async (c) => {
      await c.query(
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'sc3d2-mig', 'Mig', 'ACTIVE', now())`,
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
      operatorId = (
        await c.query<{ id: string }>(
          `INSERT INTO "PlatformOperator" (id, "externalProvider", "externalSubject", email, status, "updatedAt")
           VALUES (gen_random_uuid()::text, 'platform-dev', 'platform-dev:sc3d2-mig', 'op@example.test', 'ACTIVE', now())
           RETURNING id`,
        )
      ).rows[0].id;
    });
    // A preview that exists BEFORE the migration (SC3d-1).
    existing = await preview();
    await applyMigrations(scratch.url, [all[at]]);
    expect(
      (
        await query(
          `SELECT status, "confirmedAt", "operatorReason" FROM "BillingPlanChange" WHERE id = $1`,
          [existing],
        )
      ).rows,
    ).toEqual([
      { status: 'PREVIEWED', confirmedAt: null, operatorReason: null },
    ]);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('a confirmed state always carries its confirmation time, set once; a preview never does', async () => {
    const id = await preview();
    await expectRefused(
      `UPDATE "BillingPlanChange" SET "confirmedAt" = now() WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingPlanChange" SET status = 'REQUESTED' WHERE id = $1`,
      [id],
    );
    await query(
      `UPDATE "BillingPlanChange" SET status = 'REQUESTED', "confirmedAt" = now() WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingPlanChange" SET "confirmedAt" = now() + interval '1 minute' WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingPlanChange" SET "confirmedAt" = NULL WHERE id = $1`,
      [id],
    );
    await query(
      `UPDATE "BillingPlanChange" SET status = 'CANCELED', "finishedAt" = now() WHERE id = $1`,
      [id],
    );
  });

  it("an operator's reason: only on operator rows, 10–500 characters, never changed", async () => {
    await expect(preview('STAFF', 'Owner asked by phone.')).rejects.toThrow();
    await expect(preview('OPERATOR', 'short')).rejects.toThrow();
    const id = await preview('OPERATOR', 'Owner asked by phone.');
    await expectRefused(
      `UPDATE "BillingPlanChange" SET "operatorReason" = 'Something else entirely.' WHERE id = $1`,
      [id],
    );
  });

  it('the rollback refuses while a change was confirmed or carries a reason', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    const columns = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'BillingPlanChange' AND column_name IN ('confirmedAt', 'operatorReason')`,
    );
    expect(columns.rows).toHaveLength(2);
  });

  it('the rollback restores the SC3d-1 shape (and its guard) when nothing was confirmed', async () => {
    const clean = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3d2_rollback_clean',
    );
    try {
      await applyMigrations(clean.url, listMigrations(MIGRATIONS));
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      const left = await withScratchClient(
        clean.url,
        async (c) =>
          (
            await c.query<{ name: string }>(
              `SELECT column_name AS name FROM information_schema.columns
              WHERE table_name = 'BillingPlanChange' AND column_name IN ('confirmedAt', 'operatorReason')`,
            )
          ).rows,
      );
      expect(left).toEqual([]);
      const guard = await withScratchClient(
        clean.url,
        async (c) =>
          (
            await c.query<{ src: string }>(
              `SELECT prosrc AS src FROM pg_proc WHERE proname = 'guard_billing_plan_change'`,
            )
          ).rows[0].src,
      );
      expect(guard).not.toContain('operatorReason');
      expect(guard).toContain('previewAmountDueMinorUnits');
    } finally {
      await clean.drop();
    }
  });
});
