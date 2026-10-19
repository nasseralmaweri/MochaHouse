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

// ESP-03 PR 8 — migration 20261119090000_financial_holds on scratch
// databases: existing payments come through unchanged; a hold belongs, with
// its payment attempt and source, to one business; it has exactly the source
// its kind needs and a positive amount; at most one per kind per attempt; it
// is created only for a payment that may still be charged or has succeeded,
// changes only ACTIVE -> CONSUMED (payment SUCCEEDED) or ACTIVE -> RELEASED
// (payment DECLINED / FAILED), never otherwise and never twice, and is never
// deleted; the preflight refuses (changing nothing) without the ownership
// guard; and the rollback refuses while any hold exists.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const THIS_MIGRATION = '20261119090000_financial_holds';
const ROLLBACK = join(
  __dirname,
  `../../../../packages/database/prisma/rollbacks/${THIS_MIGRATION}.down.sql`,
);
const T1 = TENANT_1_MOCHA_HOUSE_ID;
const OTHER = '01a0db02-f800-7000-8000-c5a0000000b8';

jest.setTimeout(300_000);

describe('ESP-03 PR 8 financial holds migration (scratch database)', () => {
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
    status = 'PENDING',
  ) =>
    run(
      scratch,
      `INSERT INTO "PaymentAttempt" (id, "tenantId", "idempotencyKey", provider, amount, currency, status, "updatedAt")
       VALUES ($1, $2, $3, 'fake', 500, 'USD', $4::"PaymentAttemptStatus", now())`,
      [id, tenantId, `key-${id}`, status],
    );
  const setStatus = (scratch: ScratchDatabase, id: string, status: string) =>
    run(
      scratch,
      `UPDATE "PaymentAttempt" SET status = $2::"PaymentAttemptStatus" WHERE id = $1`,
      [id, status],
    );
  const hold = (
    scratch: ScratchDatabase,
    id: string,
    attemptId: string,
    values: {
      tenantId?: string;
      kind?: string;
      amount?: number;
      promotionId?: string | null;
      giftCardId?: string | null;
      status?: string;
    } = {},
  ) =>
    run(
      scratch,
      `INSERT INTO "FinancialHold" (id, "tenantId", "paymentAttemptId", kind, amount, "promotionId", "giftCardId", status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        values.tenantId ?? T1,
        attemptId,
        values.kind ?? 'GIFT_CARD_TENDER',
        values.amount ?? 100,
        values.promotionId === undefined ? null : values.promotionId,
        values.giftCardId === undefined ? 'gc-1' : values.giftCardId,
        values.status ?? 'ACTIVE',
      ],
    );
  const count = async (scratch: ScratchDatabase) =>
    (await run(scratch, `SELECT count(*)::int AS n FROM "FinancialHold"`))
      .rows[0].n as number;

  it('is listed after every earlier migration', () => {
    expect(at).toBeGreaterThan(0);
  });

  describe('applied', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp03_pr8_holds',
      );
      await applyMigrations(scratch.url, before);
      await run(
        scratch,
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt")
         VALUES ($1, 'holds-other', 'Other Business', 'ACTIVE', now())
         ON CONFLICT DO NOTHING`,
        [OTHER],
      );
      for (const [id, tenantId] of [
        ['gc-1', T1],
        ['gc-other', OTHER],
      ]) {
        await run(
          scratch,
          `INSERT INTO "GiftCard" (id, "tenantId", "codeHash", last4, "originalValueMinorUnits", "balanceMinorUnits", currency, "updatedAt")
           VALUES ($1, $2, $3, '1234', 1000, 1000, 'USD', now())`,
          [id, tenantId, `hash-${id}`],
        );
      }
      await run(
        scratch,
        `INSERT INTO "Promotion" (id, "tenantId", name, kind, "discountType", "discountValue", "updatedAt")
         VALUES ('promo-1', $1, 'Promo', 'AUTOMATIC', 'FIXED_AMOUNT', 100, now())`,
        [T1],
      );
      await attempt(scratch, 'pa-existing');
      await applyMigrations(scratch.url, thisOne);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('leaves existing payments exactly as they were, with no holds', async () => {
      const { rows } = await run(
        scratch,
        `SELECT id, status::text AS status FROM "PaymentAttempt"`,
      );
      expect(rows).toEqual([{ id: 'pa-existing', status: 'PENDING' }]);
      expect(await count(scratch)).toBe(0);
    });

    it('a hold has exactly its kind’s source, a positive amount, and one per kind per attempt', async () => {
      await attempt(scratch, 'pa-1');
      await hold(scratch, 'h-1', 'pa-1');
      await expect(hold(scratch, 'h-dup', 'pa-1')).rejects.toThrow(/unique/);
      for (const [i, values] of [
        { amount: 0 },
        { kind: 'SOMETHING' },
        { kind: 'PROMOTION_REDEMPTION' }, // no promotion, has a card
        {
          kind: 'PROMOTION_REDEMPTION',
          promotionId: 'promo-1',
          giftCardId: null,
          amount: 2,
        },
        { giftCardId: null },
      ].entries()) {
        await attempt(scratch, `pa-bad-${i}`);
        await expect(
          hold(scratch, `h-bad-${i}`, `pa-bad-${i}`, values),
        ).rejects.toThrow(/check constraint/);
      }
      await attempt(scratch, 'pa-promo');
      await hold(scratch, 'h-promo', 'pa-promo', {
        kind: 'PROMOTION_REDEMPTION',
        promotionId: 'promo-1',
        giftCardId: null,
        amount: 1,
      });
    });

    it('belongs, with its payment and source, to one business, and never moves', async () => {
      await attempt(scratch, 'pa-other', OTHER);
      // Another business's card for this business's payment, and the reverse.
      await attempt(scratch, 'pa-cross');
      await expect(
        hold(scratch, 'h-cross', 'pa-cross', { giftCardId: 'gc-other' }),
      ).rejects.toThrow(/foreign key/);
      await expect(
        hold(scratch, 'h-cross-2', 'pa-other', { tenantId: T1 }),
        // Refused by the guard (no such payment in this business) or the key.
      ).rejects.toThrow(/foreign key|may still be charged/);
      await expect(
        run(
          scratch,
          `UPDATE "FinancialHold" SET "tenantId" = $1 WHERE id = 'h-1'`,
          [OTHER],
        ),
      ).rejects.toThrow();
    });

    it('is created ACTIVE, only for a payment that may still be charged or has succeeded', async () => {
      await attempt(scratch, 'pa-new');
      await expect(
        hold(scratch, 'h-consumed', 'pa-new', { status: 'CONSUMED' }),
      ).rejects.toThrow();
      await attempt(scratch, 'pa-declined', T1, 'DECLINED');
      await expect(hold(scratch, 'h-declined', 'pa-declined')).rejects.toThrow(
        /may still be charged/,
      );
    });

    it('settles only once: consumed for a successful payment, released for a declined or failed one; never deleted or edited', async () => {
      const consume = (id: string) =>
        run(
          scratch,
          `UPDATE "FinancialHold" SET status = 'CONSUMED', "consumedAt" = now() WHERE id = $1`,
          [id],
        );
      const release = (id: string, reason = 'DECLINED') =>
        run(
          scratch,
          `UPDATE "FinancialHold" SET status = 'RELEASED', "releasedAt" = now(), "releaseReason" = $2 WHERE id = $1`,
          [id, reason],
        );
      // Payment still pending: neither.
      await expect(consume('h-1')).rejects.toThrow(/consumed only/);
      await expect(release('h-1')).rejects.toThrow(/released only/);
      // Succeeded: consumed once, never released, never again.
      await setStatus(scratch, 'pa-1', 'SUCCEEDED');
      await expect(release('h-1')).rejects.toThrow(/released only/);
      await consume('h-1');
      await expect(consume('h-1')).rejects.toThrow();
      await expect(
        run(scratch, `UPDATE "FinancialHold" SET amount = 5 WHERE id = 'h-1'`),
      ).rejects.toThrow(/never change/);
      await expect(
        run(scratch, `DELETE FROM "FinancialHold" WHERE id = 'h-1'`),
      ).rejects.toThrow(/never deleted/);
      // Declined by any path: released by the database in the same
      // statement, once.
      await setStatus(scratch, 'pa-promo', 'DECLINED');
      const { rows } = await run(
        scratch,
        `SELECT status, "releaseReason" FROM "FinancialHold" WHERE id = 'h-promo'`,
      );
      expect(rows).toEqual([{ status: 'RELEASED', releaseReason: 'DECLINED' }]);
      await expect(release('h-promo')).rejects.toThrow(/never changes/);
      await expect(consume('h-promo')).rejects.toThrow(/settled only once/);
      // A FAILED payment, and an abandoned (never sent) one.
      await attempt(scratch, 'pa-fail');
      await hold(scratch, 'h-fail', 'pa-fail');
      await setStatus(scratch, 'pa-fail', 'FAILED');
      await attempt(scratch, 'pa-abandon');
      await hold(scratch, 'h-abandon', 'pa-abandon', { giftCardId: 'gc-1' });
      await run(
        scratch,
        `UPDATE "PaymentAttempt" SET status = 'FAILED', "paymentState" = 'ABANDONED' WHERE id = 'pa-abandon'`,
      );
      const settled = await run(
        scratch,
        `SELECT id, "releaseReason" FROM "FinancialHold" WHERE id IN ('h-fail', 'h-abandon') ORDER BY id`,
      );
      expect(settled.rows).toEqual([
        { id: 'h-abandon', releaseReason: 'ABANDONED' },
        { id: 'h-fail', releaseReason: 'FAILED' },
      ]);
    });

    it('the rollback refuses while any hold exists, changing nothing', async () => {
      await expect(
        applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
      ).rejects.toThrow(/rollback refused/);
      expect(await count(scratch)).toBeGreaterThan(0);
    });
  });

  describe('rollback with nothing to keep', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp03_pr8_rollback',
      );
      await applyMigrations(scratch.url, [...before, ...thisOne]);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('removes the table and both trigger functions', async () => {
      await applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8'));
      const { rows } = await run(
        scratch,
        `SELECT to_regclass('"FinancialHold"') IS NULL AS gone,
                to_regprocedure('financial_hold_guard()') IS NULL AS guard_gone,
                to_regprocedure('release_financial_holds_on_outcome()') IS NULL AS release_gone`,
      );
      expect(rows).toEqual([
        { gone: true, guard_gone: true, release_gone: true },
      ]);
    });
  });

  describe('preflight', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp03_pr8_preflight',
      );
      await applyMigrations(scratch.url, before);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('refuses, changing nothing, when the ownership guard function is missing', async () => {
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
          `SELECT to_regclass('"FinancialHold"') IS NULL AS absent,
                  to_regprocedure('financial_hold_guard()') IS NULL AS guard_absent`,
        );
        expect(rows).toEqual([{ absent: true, guard_absent: true }]);
      } finally {
        await run(
          scratch,
          `ALTER FUNCTION reject_tenant_reassignment_hidden() RENAME TO reject_tenant_reassignment`,
        );
      }
    });
  });
});
