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

// ESP-03 PR 4 — migration 20261115090000_checkout_snapshots on scratch
// databases: existing payments come through unchanged; a saved checkout is
// bounded, belongs to a payment attempt of its own business and can never
// move to another business; the preflight refuses (changing nothing) when the
// ownership guard is missing; and the rollback refuses while any saved
// checkout still backs a payment awaiting its order.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const THIS_MIGRATION = '20261115090000_checkout_snapshots';
const ROLLBACK = join(
  __dirname,
  `../../../../packages/database/prisma/rollbacks/${THIS_MIGRATION}.down.sql`,
);
const T1 = TENANT_1_MOCHA_HOUSE_ID;
const OTHER = '01a0db02-f800-7000-8000-c5a0000000b2';

jest.setTimeout(240_000);

describe('ESP-03 PR 4 checkout snapshots migration (scratch database)', () => {
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
  const insertAttempt = (scratch: ScratchDatabase, id: string, tenantId = T1) =>
    run(
      scratch,
      `INSERT INTO "PaymentAttempt" (id, "tenantId", "idempotencyKey", provider, amount, currency, "updatedAt")
       VALUES ($1, $2, $3, 'fake', 500, 'USD', now())`,
      [id, tenantId, `key-${id}`],
    );
  const insertSnapshot = (
    scratch: ScratchDatabase,
    id: string,
    attemptId: string,
    values: { tenantId?: string; version?: number; payload?: string } = {},
  ) =>
    run(
      scratch,
      `INSERT INTO "CheckoutSnapshot" (id, "paymentAttemptId", "tenantId", version, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        id,
        attemptId,
        values.tenantId ?? T1,
        values.version ?? 1,
        values.payload ?? '{"locationId":"loc"}',
      ],
    );

  it('is listed after every earlier migration', () => {
    expect(at).toBeGreaterThan(0);
  });

  describe('applied', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp03_pr4_snapshots',
      );
      await applyMigrations(scratch.url, before);
      await run(
        scratch,
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt")
         VALUES ($1, 'snapshot-other', 'Other Business', 'ACTIVE', now())
         ON CONFLICT DO NOTHING`,
        [OTHER],
      );
      await insertAttempt(scratch, 'pa-existing');
      await applyMigrations(scratch.url, thisOne);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('leaves existing payments exactly as they were, with no saved checkout', async () => {
      const { rows } = await run(
        scratch,
        `SELECT id, amount, "paymentState", "fulfilmentStatus" FROM "PaymentAttempt"`,
      );
      expect(rows).toEqual([
        {
          id: 'pa-existing',
          amount: 500,
          paymentState: null,
          fulfilmentStatus: null,
        },
      ]);
      expect(
        (
          await run(
            scratch,
            `SELECT count(*)::int AS n FROM "CheckoutSnapshot"`,
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it('bounds a saved checkout and keeps one per payment attempt', async () => {
      await insertSnapshot(scratch, 'cs-ok', 'pa-existing');
      await expect(
        insertSnapshot(scratch, 'cs-dup', 'pa-existing'),
      ).rejects.toThrow(/unique/);
      await insertAttempt(scratch, 'pa-2');
      for (const values of [
        { version: 2 },
        { payload: '[1,2]' },
        { payload: '"text"' },
        { payload: JSON.stringify({ blob: 'x'.repeat(70_000) }) },
      ]) {
        await expect(
          insertSnapshot(
            scratch,
            `cs-bad-${values.version ?? 'p'}`,
            'pa-2',
            values,
          ),
        ).rejects.toThrow(/check constraint/);
      }
    });

    it("belongs to its own business's payment attempt and never moves", async () => {
      await insertAttempt(scratch, 'pa-other', OTHER);
      // A saved checkout naming another business's payment attempt.
      await expect(
        insertSnapshot(scratch, 'cs-cross', 'pa-other', { tenantId: T1 }),
      ).rejects.toThrow(/foreign key/);
      await expect(
        run(
          scratch,
          `UPDATE "CheckoutSnapshot" SET "tenantId" = $1 WHERE id = 'cs-ok'`,
          [OTHER],
        ),
      ).rejects.toThrow();
    });

    it('the rollback refuses while a saved checkout remains, and removes the table once none does', async () => {
      const sql = readFileSync(ROLLBACK, 'utf8');
      await expect(applyMigrationSql(scratch.url, sql)).rejects.toThrow(
        /rollback refused/,
      );
      expect(
        (
          await run(
            scratch,
            `SELECT count(*)::int AS n FROM "CheckoutSnapshot"`,
          )
        ).rows[0].n,
      ).toBeGreaterThan(0);
      await run(scratch, `DELETE FROM "CheckoutSnapshot"`);
      await applyMigrationSql(scratch.url, sql);
      const { rows } = await run(
        scratch,
        `SELECT to_regclass('"CheckoutSnapshot"') IS NULL AS gone`,
      );
      expect(rows).toEqual([{ gone: true }]);
      // Payments are untouched by the rollback.
      expect(
        (await run(scratch, `SELECT count(*)::int AS n FROM "PaymentAttempt"`))
          .rows[0].n,
      ).toBe(3);
    });
  });

  describe('preflight', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp03_pr4_preflight',
      );
      await applyMigrations(scratch.url, before);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('refuses, changing nothing, when the ownership guard function is missing', async () => {
      // Simulated by renaming it for the duration of the check.
      await run(
        scratch,
        `ALTER FUNCTION reject_tenant_reassignment() RENAME TO reject_tenant_reassignment_hidden`,
      );
      try {
        await expect(
          applyMigrationSql(
            scratch.url,
            readFileSync(
              join(MIGRATIONS, THIS_MIGRATION, 'migration.sql'),
              'utf8',
            ),
          ),
        ).rejects.toThrow(/ownership guard function/);
        const { rows } = await run(
          scratch,
          `SELECT to_regclass('"CheckoutSnapshot"') IS NULL AS absent`,
        );
        expect(rows).toEqual([{ absent: true }]);
      } finally {
        await run(
          scratch,
          `ALTER FUNCTION reject_tenant_reassignment_hidden() RENAME TO reject_tenant_reassignment`,
        );
      }
    });
  });
});
