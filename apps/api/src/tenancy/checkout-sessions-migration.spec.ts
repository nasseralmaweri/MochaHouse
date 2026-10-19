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

// ESP-03 PR 6 — migration 20261117090000_checkout_sessions on scratch
// databases: existing payments come through unchanged; a session stores only
// a token hash and belongs (with its location and customer) to one business;
// a payment attempt's session belongs to its own business; at most ONE live
// attempt per session (anything not DECLINED / FAILED); ABANDONED is only a
// closed (FAILED) state; the preflight refuses (changing nothing) without
// the ownership guard; and the rollback refuses while any session, session
// payment or ABANDONED attempt exists, otherwise restoring the previous
// state.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const THIS_MIGRATION = '20261117090000_checkout_sessions';
const ROLLBACK = join(
  __dirname,
  `../../../../packages/database/prisma/rollbacks/${THIS_MIGRATION}.down.sql`,
);
const T1 = TENANT_1_MOCHA_HOUSE_ID;
const OTHER = '01a0db02-f800-7000-8000-c5a0000000b6';
const HASH = (c: string) => c.repeat(64);

jest.setTimeout(300_000);

describe('ESP-03 PR 6 checkout sessions migration (scratch database)', () => {
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
  const location = (scratch: ScratchDatabase, id: string, tenantId: string) =>
    run(
      scratch,
      `INSERT INTO "Location" (id, "tenantId", name, slug, "updatedAt")
       VALUES ($1, $2, $1, $1, now())`,
      [id, tenantId],
    );
  const session = (
    scratch: ScratchDatabase,
    id: string,
    values: {
      tenantId?: string;
      locationId?: string;
      tokenHash?: string;
      expiresAt?: string;
    } = {},
  ) =>
    run(
      scratch,
      `INSERT INTO "CheckoutSession" (id, "tenantId", "locationId", "tokenHash", "expiresAt", "tokenExpiresAt")
       VALUES ($1, $2, $3, $4, ${values.expiresAt ?? "now() + interval '1 day'"}, now() + interval '7 days')`,
      [
        id,
        values.tenantId ?? T1,
        values.locationId ?? 'loc-1',
        values.tokenHash ?? HASH(id.slice(-1)),
      ],
    );
  const attempt = (
    scratch: ScratchDatabase,
    id: string,
    values: {
      tenantId?: string;
      sessionId?: string | null;
      fingerprint?: string | null;
      status?: string;
      paymentState?: string | null;
    } = {},
  ) =>
    run(
      scratch,
      `INSERT INTO "PaymentAttempt" (id, "tenantId", "idempotencyKey", provider, amount, currency, status, "paymentState", "checkoutSessionId", "requestFingerprint", "updatedAt")
       VALUES ($1, $2, $3, 'fake', 500, 'USD', $4::"PaymentAttemptStatus", $5, $6, $7, now())`,
      [
        id,
        values.tenantId ?? T1,
        `key-${id}`,
        values.status ?? 'PENDING',
        values.paymentState === undefined ? 'NOT_SENT' : values.paymentState,
        values.sessionId === undefined ? null : values.sessionId,
        values.fingerprint === undefined
          ? values.sessionId
            ? HASH('f')
            : null
          : values.fingerprint,
      ],
    );
  const count = async (scratch: ScratchDatabase, table: string) =>
    (await run(scratch, `SELECT count(*)::int AS n FROM "${table}"`)).rows[0]
      .n as number;

  it('is listed after every earlier migration', () => {
    expect(at).toBeGreaterThan(0);
  });

  describe('applied', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp03_pr6_sessions',
      );
      await applyMigrations(scratch.url, before);
      await run(
        scratch,
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt")
         VALUES ($1, 'sessions-other', 'Other Business', 'ACTIVE', now())
         ON CONFLICT DO NOTHING`,
        [OTHER],
      );
      await location(scratch, 'loc-1', T1);
      await location(scratch, 'loc-other', OTHER);
      await run(
        scratch,
        `INSERT INTO "PaymentAttempt" (id, "tenantId", "idempotencyKey", provider, amount, currency, "updatedAt")
         VALUES ('pa-existing', $1, 'key-existing', 'fake', 500, 'USD', now())`,
        [T1],
      );
      await applyMigrations(scratch.url, thisOne);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('leaves existing payments exactly as they were, with no session', async () => {
      const { rows } = await run(
        scratch,
        `SELECT id, status::text AS status, "paymentState", "checkoutSessionId", "requestFingerprint" FROM "PaymentAttempt"`,
      );
      expect(rows).toEqual([
        {
          id: 'pa-existing',
          status: 'PENDING',
          paymentState: null,
          checkoutSessionId: null,
          requestFingerprint: null,
        },
      ]);
      expect(await count(scratch, 'CheckoutSession')).toBe(0);
    });

    it('stores only a SHA-256 token hash, one per session, with a bounded lifetime', async () => {
      await session(scratch, 'cs-1');
      await expect(
        session(scratch, 'cs-dup', { tokenHash: HASH('1') }),
      ).rejects.toThrow(/unique/);
      await expect(
        session(scratch, 'cs-raw', { tokenHash: 'cs_not-a-hash' }),
      ).rejects.toThrow(/check constraint/);
      await expect(
        session(scratch, 'cs-past', { expiresAt: "now() - interval '1 day'" }),
      ).rejects.toThrow(/check constraint/);
    });

    it('belongs, with its location, to one business; an attempt only joins a session of its own business', async () => {
      await expect(
        session(scratch, 'cs-x', {
          tenantId: T1,
          locationId: 'loc-other',
          tokenHash: HASH('3'),
        }),
      ).rejects.toThrow(/foreign key/);
      await session(scratch, 'cs-o', {
        tenantId: OTHER,
        locationId: 'loc-other',
        tokenHash: HASH('4'),
      });
      await expect(
        attempt(scratch, 'pa-cross', { tenantId: T1, sessionId: 'cs-o' }),
      ).rejects.toThrow(/foreign key/);
      await expect(
        run(
          scratch,
          `UPDATE "CheckoutSession" SET "tenantId" = $1 WHERE id = 'cs-1'`,
          [OTHER],
        ),
      ).rejects.toThrow();
      // A session attempt always carries its fingerprint (and only it does).
      await expect(
        attempt(scratch, 'pa-nofp', { sessionId: 'cs-1', fingerprint: null }),
      ).rejects.toThrow(/check constraint/);
      await expect(
        attempt(scratch, 'pa-fp-only', {
          sessionId: null,
          fingerprint: HASH('e'),
        }),
      ).rejects.toThrow(/check constraint/);
    });

    it('allows at most one live attempt per session: anything not DECLINED or FAILED', async () => {
      await attempt(scratch, 'pa-declined', {
        sessionId: 'cs-1',
        status: 'DECLINED',
        paymentState: 'DECLINED',
      });
      await attempt(scratch, 'pa-failed', {
        sessionId: 'cs-1',
        status: 'FAILED',
        paymentState: 'FAILED',
      });
      await attempt(scratch, 'pa-live', {
        sessionId: 'cs-1',
        status: 'PENDING',
        paymentState: 'UNKNOWN',
      });
      for (const [id, status, state] of [
        ['pa-2', 'PENDING', 'NOT_SENT'],
        ['pa-3', 'PENDING', 'CHARGING'],
        ['pa-4', 'PENDING', 'AWAITING_CONFIRMATION'],
        ['pa-5', 'SUCCEEDED', 'SUCCEEDED'],
        ['pa-6', 'PENDING', null],
      ] as const) {
        await expect(
          attempt(scratch, id, {
            sessionId: 'cs-1',
            status,
            paymentState: state,
          }),
        ).rejects.toThrow(/unique/);
      }
    });

    it('ABANDONED is a payment state, and only a closed (FAILED) one', async () => {
      await session(scratch, 'cs-2');
      await attempt(scratch, 'pa-abandoned', {
        sessionId: 'cs-2',
        status: 'FAILED',
        paymentState: 'ABANDONED',
      });
      await expect(
        attempt(scratch, 'pa-bad-abandoned', {
          status: 'PENDING',
          paymentState: 'ABANDONED',
        }),
      ).rejects.toThrow(/check constraint/);
      await expect(
        attempt(scratch, 'pa-bogus', { paymentState: 'SOMETHING' }),
      ).rejects.toThrow(/check constraint/);
    });

    it('the rollback refuses while sessions or session payments exist, changing nothing', async () => {
      await expect(
        applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
      ).rejects.toThrow(/rollback refused/);
      expect(await count(scratch, 'CheckoutSession')).toBeGreaterThan(0);
    });
  });

  describe('rollback with nothing to keep', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp03_pr6_rollback',
      );
      await applyMigrations(scratch.url, [...before, ...thisOne]);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('removes the table, columns and index, and restores the previous payment states', async () => {
      await applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8'));
      const { rows } = await run(
        scratch,
        `SELECT to_regclass('"CheckoutSession"') IS NULL AS gone,
                to_regclass('"PaymentAttempt_live_per_checkout_session"') IS NULL AS index_gone,
                (SELECT count(*)::int FROM information_schema.columns
                  WHERE table_name = 'PaymentAttempt'
                    AND column_name IN ('checkoutSessionId', 'requestFingerprint')) AS columns`,
      );
      expect(rows).toEqual([{ gone: true, index_gone: true, columns: 0 }]);
      await expect(
        run(
          scratch,
          `INSERT INTO "PaymentAttempt" (id, "tenantId", "idempotencyKey", provider, amount, currency, status, "paymentState", "updatedAt")
           VALUES ('pa-x', $1, 'key-x', 'fake', 1, 'USD', 'FAILED', 'ABANDONED', now())`,
          [T1],
        ),
      ).rejects.toThrow(/check constraint/);
    });
  });

  describe('preflight', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp03_pr6_preflight',
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
          `SELECT to_regclass('"CheckoutSession"') IS NULL AS absent,
                  (SELECT count(*)::int FROM information_schema.columns
                    WHERE table_name = 'PaymentAttempt' AND column_name = 'checkoutSessionId') AS columns`,
        );
        expect(rows).toEqual([{ absent: true, columns: 0 }]);
      } finally {
        await run(
          scratch,
          `ALTER FUNCTION reject_tenant_reassignment_hidden() RENAME TO reject_tenant_reassignment`,
        );
      }
    });
  });
});
