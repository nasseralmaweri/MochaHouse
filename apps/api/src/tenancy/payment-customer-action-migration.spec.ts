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

// ESP-04 M2 — migration 20261121090000_payment_customer_action on scratch
// databases: existing payments come through unchanged; REQUIRES_CUSTOMER_ACTION
// is a payment state that is always live (PENDING) and always names the
// provider's intent; the preflight refuses (changing nothing) when applied
// twice; and the rollback refuses while any payment waits for its customer,
// otherwise restoring the previous payment states.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const THIS_MIGRATION = '20261121090000_payment_customer_action';
const MIGRATION_SQL = join(MIGRATIONS, THIS_MIGRATION, 'migration.sql');
const ROLLBACK = join(
  __dirname,
  `../../../../packages/database/prisma/rollbacks/${THIS_MIGRATION}.down.sql`,
);
const T1 = TENANT_1_MOCHA_HOUSE_ID;

jest.setTimeout(300_000);

describe('ESP-04 M2 payment customer-action migration (scratch database)', () => {
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
  const attempt = (
    scratch: ScratchDatabase,
    id: string,
    status: string,
    paymentState: string | null,
    providerReference: string | null = null,
  ) =>
    run(
      scratch,
      `INSERT INTO "PaymentAttempt" (id, "tenantId", "idempotencyKey", provider, amount, currency, status, "paymentState", "providerReference", "updatedAt")
       VALUES ($1, $2, $3, 'fake-two-step', 500, 'USD', $4::"PaymentAttemptStatus", $5, $6, now())`,
      [id, T1, `key-${id}`, status, paymentState, providerReference],
    );

  it('is listed after every earlier migration', () => {
    expect(at).toBeGreaterThan(0);
  });

  describe('applied', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp04_m2_customer_action',
      );
      await applyMigrations(scratch.url, before);
      await attempt(
        scratch,
        'pa-held',
        'PENDING',
        'AWAITING_CONFIRMATION',
        'ref-held',
      );
      await attempt(scratch, 'pa-paid', 'SUCCEEDED', 'SUCCEEDED', 'ref-paid');
      await applyMigrations(scratch.url, thisOne);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('leaves existing payments exactly as they were', async () => {
      const { rows } = await run(
        scratch,
        `SELECT id, status::text AS status, "paymentState", "providerReference"
           FROM "PaymentAttempt" ORDER BY id`,
      );
      expect(rows).toEqual([
        {
          id: 'pa-held',
          status: 'PENDING',
          paymentState: 'AWAITING_CONFIRMATION',
          providerReference: 'ref-held',
        },
        {
          id: 'pa-paid',
          status: 'SUCCEEDED',
          paymentState: 'SUCCEEDED',
          providerReference: 'ref-paid',
        },
      ]);
    });

    it('accepts a live payment waiting for its customer that names its intent', async () => {
      await attempt(
        scratch,
        'pa-wait',
        'PENDING',
        'REQUIRES_CUSTOMER_ACTION',
        'ref-wait',
      );
      // ...and it moves on exactly like any live payment.
      await run(
        scratch,
        `UPDATE "PaymentAttempt" SET status = 'SUCCEEDED', "paymentState" = 'SUCCEEDED' WHERE id = 'pa-wait'`,
      );
    });

    it('refuses one without its intent, one that is not live, and an unknown state', async () => {
      await expect(
        attempt(scratch, 'pa-noref', 'PENDING', 'REQUIRES_CUSTOMER_ACTION'),
      ).rejects.toThrow(/check constraint/);
      for (const status of ['SUCCEEDED', 'FAILED', 'DECLINED']) {
        await expect(
          attempt(
            scratch,
            `pa-${status}`,
            status,
            'REQUIRES_CUSTOMER_ACTION',
            'ref',
          ),
        ).rejects.toThrow(/check constraint/);
      }
      await attempt(
        scratch,
        'pa-wait2',
        'PENDING',
        'REQUIRES_CUSTOMER_ACTION',
        'ref-2',
      );
      await expect(
        run(
          scratch,
          `UPDATE "PaymentAttempt" SET "providerReference" = NULL WHERE id = 'pa-wait2'`,
        ),
      ).rejects.toThrow(/check constraint/);
      await expect(
        attempt(scratch, 'pa-bogus', 'PENDING', 'SOMETHING'),
      ).rejects.toThrow(/check constraint/);
    });

    it('refuses to apply twice, changing nothing', async () => {
      await expect(
        applyMigrationSql(scratch.url, readFileSync(MIGRATION_SQL, 'utf8')),
      ).rejects.toThrow(/already exists/);
    });

    it('the rollback refuses while a payment waits for its customer, changing nothing', async () => {
      await expect(
        applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
      ).rejects.toThrow(/rollback refused/);
      const { rows } = await run(
        scratch,
        `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'PaymentAttempt_customer_action_check'`,
      );
      expect(rows[0].n).toBe(1);
    });
  });

  describe('rollback with nothing waiting', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp04_m2_customer_action_rb',
      );
      await applyMigrations(scratch.url, [...before, ...thisOne]);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('restores the previous payment states', async () => {
      await applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8'));
      await expect(
        attempt(scratch, 'pa-x', 'PENDING', 'REQUIRES_CUSTOMER_ACTION', 'ref'),
      ).rejects.toThrow(/check constraint/);
      await attempt(scratch, 'pa-ok', 'PENDING', 'UNKNOWN');
      const { rows } = await run(
        scratch,
        `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'PaymentAttempt_customer_action_check'`,
      );
      expect(rows[0].n).toBe(0);
    });
  });
});
