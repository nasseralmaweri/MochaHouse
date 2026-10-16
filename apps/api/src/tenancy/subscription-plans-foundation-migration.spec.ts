import 'dotenv/config';
import { randomUUID } from 'node:crypto';
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

// SC2a — migration 20261024090000_subscription_plans_foundation, on scratch
// databases: every business that exists when it runs (Mocha House
// included) is put on the published Founding plan with every module; module
// keys and history shapes are checked by the database; history is
// append-only; the documented rollback restores the previous shape on a
// database with only the Founding backfill — and refuses once real plan
// data exists.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261024090000_subscription_plans_foundation.down.sql',
);
const THIS = '20261024090000_subscription_plans_foundation';
const OTHER_TENANT = '01a0db02-f800-7000-8000-7e5700002a01';

describe('SC2a subscription plans foundation migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  const sql = <T>(fn: (client: Client) => Promise<T>) =>
    withScratchClient(scratch.url, fn);

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc2a_migration',
    );
    const all = listMigrations(MIGRATIONS);
    const at = all.findIndex((migration) => migration.name === THIS);
    expect(at).toBeGreaterThan(0);
    await applyMigrations(scratch.url, all.slice(0, at));
    // A second business that already exists before plans are introduced.
    await sql((c) =>
      c.query(
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'sc2a-existing', 'Existing', 'ACTIVE', now())`,
        [OTHER_TENANT],
      ),
    );
    await applyMigrations(scratch.url, [all[at]]);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('puts every existing business — Mocha House and the other — on Founding v1 (published, every module), with one history row each', async () => {
    const rows = await sql(
      async (c) =>
        (
          await c.query<{
            tenant: string;
            key: string;
            version: number;
            status: string;
            modules: number;
            events: string;
          }>(
            `SELECT s."subscriberTenantId" AS tenant, p.key, v.version, v.status::text AS status,
                  cardinality(v."moduleKeys") AS modules,
                  (SELECT count(*) FROM "TenantSubscriptionEvent" e WHERE e."subscriptionId" = s.id)::text AS events
             FROM "TenantSubscription" s
             JOIN "SubscriptionPlanVersion" v ON v.id = s."planVersionId"
             JOIN "SubscriptionPlan" p ON p.id = v."planId"
            ORDER BY s."subscriberTenantId"`,
          )
        ).rows,
    );
    expect(rows).toEqual(
      [TENANT_1_MOCHA_HOUSE_ID, OTHER_TENANT].sort().map((tenant) => ({
        tenant,
        key: 'founding',
        version: 1,
        status: 'PUBLISHED',
        modules: 9,
        events: '1',
      })),
    );
  });

  it('refuses unknown modules, malformed history and a second subscription for a business', async () => {
    const versionId = randomUUID();
    await expect(
      sql((c) =>
        c.query(
          `INSERT INTO "SubscriptionPlanVersion" (id, "planId", version, "moduleKeys", "updatedAt")
           SELECT $1, id, 9, ARRAY['payments']::text[], now() FROM "SubscriptionPlan" WHERE key = 'founding'`,
          [versionId],
        ),
      ),
    ).rejects.toThrow(/moduleKeys_check/);
    await expect(
      sql((c) =>
        c.query(
          `INSERT INTO "TenantSubscriptionEvent" (id, "subscriptionId", type)
           SELECT $1, id, 'ADDON_GRANTED' FROM "TenantSubscription" LIMIT 1`,
          [randomUUID()],
        ),
      ),
    ).rejects.toThrow(/shape_check/);
    await expect(
      sql((c) =>
        c.query(
          `INSERT INTO "TenantSubscription" (id, "subscriberTenantId", "planVersionId", "updatedAt")
           SELECT $1, $2, "planVersionId", now() FROM "TenantSubscription" LIMIT 1`,
          [randomUUID(), TENANT_1_MOCHA_HOUSE_ID],
        ),
      ),
    ).rejects.toThrow(/subscriberTenantId_key/);
  });

  it('history is append-only; the published Founding version is immutable', async () => {
    for (const statement of [
      `UPDATE "TenantSubscriptionEvent" SET "moduleKey" = NULL`,
      `DELETE FROM "TenantSubscriptionEvent"`,
      `TRUNCATE "TenantSubscriptionEvent"`,
    ]) {
      await expect(sql((c) => c.query(statement))).rejects.toThrow(
        /append-only/,
      );
    }
    await expect(
      sql((c) =>
        c.query(
          `UPDATE "SubscriptionPlanVersion" SET "moduleKeys" = ARRAY[]::text[]`,
        ),
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('the rollback restores the previous shape on a database with only the Founding backfill', async () => {
    const fresh = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc2a_rollback',
    );
    try {
      await applyMigrations(fresh.url, listMigrations(MIGRATIONS));
      await applyMigrationSql(fresh.url, readFileSync(ROLLBACK, 'utf8'));
      const table = await withScratchClient(
        fresh.url,
        async (c) =>
          (
            await c.query(
              `SELECT to_regclass('public."TenantSubscription"') AS t`,
            )
          ).rows[0] as { t: string | null },
      );
      expect(table.t).toBeNull();
    } finally {
      await fresh.drop();
    }
  });

  it('the rollback refuses once real plan data exists, changing nothing', async () => {
    await sql((c) =>
      c.query(
        `INSERT INTO "SubscriptionPlan" (id, key, name, "updatedAt") VALUES ($1, 'extra', 'Extra', now())`,
        [randomUUID()],
      ),
    );
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/SC2a rollback refused/);
    const count = await sql(async (c) =>
      Number(
        (
          await c.query<{ n: string }>(
            `SELECT count(*) AS n FROM "TenantSubscription"`,
          )
        ).rows[0].n,
      ),
    );
    expect(count).toBe(2);
  });
});
