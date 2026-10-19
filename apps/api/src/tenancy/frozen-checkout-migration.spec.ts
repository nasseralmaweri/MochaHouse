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

// ESP-03 PR 7 — migration 20261118090000_frozen_checkout on scratch
// databases: existing payments and saved checkouts come through unchanged;
// payment keys are unique per business (and still globally); a saved
// checkout may be version 1 or 2, up to 256 KB; the preflight refuses
// (changing nothing) when the index already exists; and the rollback
// refuses while any version-2 (or oversized) saved checkout exists,
// otherwise restoring the previous state.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const THIS_MIGRATION = '20261118090000_frozen_checkout';
const ROLLBACK = join(
  __dirname,
  `../../../../packages/database/prisma/rollbacks/${THIS_MIGRATION}.down.sql`,
);
const T1 = TENANT_1_MOCHA_HOUSE_ID;
const OTHER = '01a0db02-f800-7000-8000-c5a0000000b7';
const INDEX = 'PaymentAttempt_tenantId_idempotencyKey_key';

jest.setTimeout(300_000);

describe('ESP-03 PR 7 frozen checkout migration (scratch database)', () => {
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
    tenantId = T1,
    key = `key-${id}`,
  ) =>
    run(
      scratch,
      `INSERT INTO "PaymentAttempt" (id, "tenantId", "idempotencyKey", provider, amount, currency, "updatedAt")
       VALUES ($1, $2, $3, 'fake', 500, 'USD', now())`,
      [id, tenantId, key],
    );
  const snapshot = (
    scratch: ScratchDatabase,
    id: string,
    attemptId: string,
    values: { version?: number; payload?: string } = {},
  ) =>
    run(
      scratch,
      `INSERT INTO "CheckoutSnapshot" (id, "paymentAttemptId", "tenantId", version, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        id,
        attemptId,
        T1,
        values.version ?? 1,
        values.payload ?? JSON.stringify({ locationId: 'loc-1' }),
      ],
    );
  const indexExists = async (scratch: ScratchDatabase) =>
    (
      await run(scratch, `SELECT to_regclass($1) IS NOT NULL AS present`, [
        `"${INDEX}"`,
      ])
    ).rows[0].present as boolean;

  it('is listed after every earlier migration', () => {
    expect(at).toBeGreaterThan(0);
  });

  describe('applied', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp03_pr7_frozen',
      );
      await applyMigrations(scratch.url, before);
      await run(
        scratch,
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt")
         VALUES ($1, 'frozen-other', 'Other Business', 'ACTIVE', now())
         ON CONFLICT DO NOTHING`,
        [OTHER],
      );
      await attempt(scratch, 'pa-existing');
      await snapshot(scratch, 'cs-existing', 'pa-existing');
      await applyMigrations(scratch.url, thisOne);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('leaves existing payments and saved checkouts exactly as they were', async () => {
      const { rows } = await run(
        scratch,
        `SELECT a.id, a."idempotencyKey", s.version, s.payload
           FROM "PaymentAttempt" a JOIN "CheckoutSnapshot" s ON s."paymentAttemptId" = a.id`,
      );
      expect(rows).toEqual([
        {
          id: 'pa-existing',
          idempotencyKey: 'key-pa-existing',
          version: 1,
          payload: { locationId: 'loc-1' },
        },
      ]);
    });

    it('payment keys are unique per business, and the global unique key is kept', async () => {
      expect(await indexExists(scratch)).toBe(true);
      await expect(
        attempt(scratch, 'pa-dup', T1, 'key-pa-existing'),
      ).rejects.toThrow(/unique/);
      // The global key still refuses the same key under another business.
      await expect(
        attempt(scratch, 'pa-other', OTHER, 'key-pa-existing'),
      ).rejects.toThrow(/unique/);
      await attempt(scratch, 'pa-other-own', OTHER);
    });

    it('accepts version 1 and 2 saved checkouts up to 256 KB, and nothing else', async () => {
      await attempt(scratch, 'pa-v2');
      await snapshot(scratch, 'cs-v2', 'pa-v2', {
        version: 2,
        payload: JSON.stringify({ blob: 'x'.repeat(200_000) }),
      });
      await attempt(scratch, 'pa-bad');
      for (const [i, values] of [
        { version: 3 },
        { version: 0 },
        { payload: '[1,2]' },
        { payload: JSON.stringify({ blob: 'x'.repeat(270_000) }) },
      ].entries()) {
        await expect(
          snapshot(scratch, `cs-bad-${i}`, 'pa-bad', values),
        ).rejects.toThrow(/check constraint/);
      }
    });

    it('the rollback refuses while a version-2 saved checkout exists, changing nothing', async () => {
      await expect(
        applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
      ).rejects.toThrow(/rollback refused/);
      expect(await indexExists(scratch)).toBe(true);
    });

    it('the rollback restores the previous state once none remains', async () => {
      await run(scratch, `DELETE FROM "CheckoutSnapshot" WHERE version = 2`);
      await applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8'));
      expect(await indexExists(scratch)).toBe(false);
      await attempt(scratch, 'pa-after');
      await expect(
        snapshot(scratch, 'cs-after', 'pa-after', { version: 2 }),
      ).rejects.toThrow(/check constraint/);
      await expect(
        snapshot(scratch, 'cs-after-big', 'pa-after', {
          payload: JSON.stringify({ blob: 'x'.repeat(70_000) }),
        }),
      ).rejects.toThrow(/check constraint/);
      // Version-1 saved checkouts and every payment are untouched.
      expect(
        (
          await run(
            scratch,
            `SELECT count(*)::int AS n FROM "CheckoutSnapshot"`,
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (await run(scratch, `SELECT count(*)::int AS n FROM "PaymentAttempt"`))
          .rows[0].n,
      ).toBe(5);
    });
  });

  describe('preflight', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp03_pr7_preflight',
      );
      await applyMigrations(scratch.url, before);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('refuses, changing nothing, when the index already exists', async () => {
      await run(
        scratch,
        `CREATE UNIQUE INDEX "${INDEX}" ON "PaymentAttempt"("tenantId", "idempotencyKey")`,
      );
      await expect(
        applyMigrationSql(
          scratch.url,
          readFileSync(
            join(MIGRATIONS, THIS_MIGRATION, 'migration.sql'),
            'utf8',
          ),
        ),
      ).rejects.toThrow(/already exists/);
      // The version check is still version 1 only.
      const { rows } = await run(
        scratch,
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'CheckoutSnapshot_version_check'`,
      );
      expect(String(rows[0].def)).toMatch(/= 1/);
    });
  });
});
