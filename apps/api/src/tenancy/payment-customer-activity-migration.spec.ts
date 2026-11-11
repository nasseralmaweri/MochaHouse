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

// ESP-04 M4b — migration 20261123090000_payment_customer_activity on scratch
// databases: existing payments come through unchanged with no recorded
// activity; the column takes a time; the abandonment scan has its partial
// index; the preflight refuses (changing nothing) when applied twice; and
// the rollback refuses while a Stripe payment waiting for its customer was
// active in the last 24 hours, otherwise restoring the previous shape.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const THIS_MIGRATION = '20261123090000_payment_customer_activity';
const MIGRATION_SQL = join(MIGRATIONS, THIS_MIGRATION, 'migration.sql');
const ROLLBACK = join(
  __dirname,
  `../../../../packages/database/prisma/rollbacks/${THIS_MIGRATION}.down.sql`,
);
const T1 = TENANT_1_MOCHA_HOUSE_ID;

jest.setTimeout(300_000);

describe('ESP-04 M4b payment customer activity migration (scratch database)', () => {
  const all = listMigrations(MIGRATIONS);
  const at = all.findIndex((m) => m.name === THIS_MIGRATION);
  const before = all.slice(0, at);
  const thisOne = all.slice(at, at + 1);

  const run = (
    scratch: ScratchDatabase,
    text: string,
    params: unknown[] = [],
  ) =>
    withScratchClient(scratch.url, (c) =>
      c.query<Record<string, unknown>>(text, params),
    );
  const waiting = (scratch: ScratchDatabase, id: string) =>
    run(
      scratch,
      `INSERT INTO "PaymentAttempt" (id, "tenantId", "idempotencyKey", provider, amount, currency, status, "paymentState", "providerReference", "providerAccountId", "updatedAt")
       VALUES ($1, $2, $3, 'stripe', 500, 'USD', 'PENDING', 'REQUIRES_CUSTOMER_ACTION', $4, 'acct_1Mig', now())`,
      [id, T1, `key-${id}`, `pi_${id.replace(/-/g, '')}`],
    );
  const count = async (scratch: ScratchDatabase, sql: string) =>
    Number((await run(scratch, sql)).rows[0].n);
  const hasColumn = (scratch: ScratchDatabase) =>
    count(
      scratch,
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'PaymentAttempt' AND column_name = 'customerActiveAt'`,
    );

  it('is listed after every earlier migration', () => {
    expect(at).toBeGreaterThan(0);
  });

  describe('applied', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp04_m4b_activity',
      );
      await applyMigrations(scratch.url, before);
      await waiting(scratch, 'pa-old');
      await applyMigrations(scratch.url, thisOne);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('leaves existing payments as they were, with no recorded activity', async () => {
      const { rows } = await run(
        scratch,
        `SELECT id, "paymentState", "customerActiveAt" FROM "PaymentAttempt"`,
      );
      expect(rows).toEqual([
        {
          id: 'pa-old',
          paymentState: 'REQUIRES_CUSTOMER_ACTION',
          customerActiveAt: null,
        },
      ]);
    });

    it('records a time and indexes the abandonment scan', async () => {
      await run(
        scratch,
        `UPDATE "PaymentAttempt" SET "customerActiveAt" = now() WHERE id = 'pa-old'`,
      );
      expect(
        await count(
          scratch,
          `SELECT count(*)::int AS n FROM pg_indexes
            WHERE indexname = 'PaymentAttempt_stripe_awaiting_customer_idx'`,
        ),
      ).toBe(1);
    });

    it('refuses to apply twice, changing nothing', async () => {
      await expect(
        applyMigrationSql(scratch.url, readFileSync(MIGRATION_SQL, 'utf8')),
      ).rejects.toThrow(/already exists/);
    });

    it('the rollback refuses while a waiting customer was recently active, changing nothing', async () => {
      await expect(
        applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
      ).rejects.toThrow(/rollback refused/);
      expect(await hasColumn(scratch)).toBe(1);
    });
  });

  describe('rollback with no recent activity', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp04_m4b_activity_rb',
      );
      await applyMigrations(scratch.url, [...before, ...thisOne]);
      await waiting(scratch, 'pa-stale');
      await run(
        scratch,
        `UPDATE "PaymentAttempt" SET "customerActiveAt" = now() - interval '3 days' WHERE id = 'pa-stale'`,
      );
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('restores the previous shape', async () => {
      await applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8'));
      expect(await hasColumn(scratch)).toBe(0);
      expect(
        await count(
          scratch,
          `SELECT count(*)::int AS n FROM pg_indexes
            WHERE indexname = 'PaymentAttempt_stripe_awaiting_customer_idx'`,
        ),
      ).toBe(0);
    });
  });
});
