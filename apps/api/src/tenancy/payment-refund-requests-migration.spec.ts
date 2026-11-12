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

// ESP-04 M5b — migration 20261125090000_payment_refund_requests on scratch
// databases: every CENTERIVO refund carries the staff request that created it
// (a UUID, unique per business, and the server's fingerprint), a refund made
// outside CENTERIVO carries none, neither ever changes; the preflight refuses
// a CENTERIVO refund made before it, and the rollback refuses while any
// CENTERIVO refund exists.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const THIS_MIGRATION = '20261125090000_payment_refund_requests';
const ROLLBACK = join(
  __dirname,
  `../../../../packages/database/prisma/rollbacks/${THIS_MIGRATION}.down.sql`,
);
const T1 = TENANT_1_MOCHA_HOUSE_ID;
const OTHER = '01a0db02-f800-7000-8000-c5a0000005b1';
const ACCT = 'acct_1M5bMigration';
const FINGERPRINT = 'a'.repeat(64);

jest.setTimeout(300_000);

describe('ESP-04 M5b payment refund requests migration (scratch database)', () => {
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

  let sequence = 0;
  async function paidOrder(scratch: ScratchDatabase, tenantId = T1) {
    const n = ++sequence;
    const slug = tenantId === T1 ? 't1' : 'other';
    await run(
      scratch,
      `INSERT INTO "PaymentAttempt" (id, "tenantId", "idempotencyKey", provider, amount, currency, status,
         "paymentState", "providerReference", "providerAccountId", "updatedAt")
       VALUES ($1, $2, $1, 'stripe', 1000, 'USD', 'SUCCEEDED', 'SUCCEEDED', $3, $4, now())`,
      [`pa-${n}`, tenantId, `pi_M5bMig${n}`, ACCT],
    );
    await run(
      scratch,
      `INSERT INTO "Order" (id, "tenantId", "orderNumber", "accessToken", "locationId", "paymentAttemptId",
         "guestName", "guestPhone", subtotal, currency, status, "updatedAt")
       VALUES ($1, $2, $1, $1, $3, $4, 'Guest', '5550000000', 1000, 'USD', 'COMPLETED', now())`,
      [`order-${n}`, tenantId, `loc-${slug}`, `pa-${n}`],
    );
    return { attemptId: `pa-${n}`, orderId: `order-${n}`, tenantId, slug };
  }
  const centerivo = (
    scratch: ScratchDatabase,
    paid: Awaited<ReturnType<typeof paidOrder>>,
    id: string,
    requestId: string | null,
    fingerprint: string | null = FINGERPRINT,
  ) =>
    run(
      scratch,
      `INSERT INTO "PaymentRefund" (id, "tenantId", "orderId", "paymentAttemptId", provider, "providerAccountId",
         origin, "amountMinorUnits", currency, "reasonCode", "requestedByInternalUserId", "idempotencyKey",
         status, "clientRequestId", "requestFingerprint", "updatedAt")
       VALUES ($1, $2, $3, $4, 'stripe', $5, 'CENTERIVO', 100, 'USD', 'CUSTOMER_REQUEST', $6,
         'centerivo-refund:' || $1, 'REQUESTED', $7, $8, now())`,
      [
        id,
        paid.tenantId,
        paid.orderId,
        paid.attemptId,
        ACCT,
        `user-${paid.slug}`,
        requestId,
        fingerprint,
      ],
    );

  async function businesses(scratch: ScratchDatabase) {
    await run(
      scratch,
      `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt")
       VALUES ($1, 'm5b-other', 'Other', 'ACTIVE', now()) ON CONFLICT (id) DO NOTHING`,
      [OTHER],
    );
    for (const [tenantId, slug] of [
      [T1, 't1'],
      [OTHER, 'other'],
    ]) {
      await run(
        scratch,
        `INSERT INTO "Location" (id, "tenantId", name, slug, "updatedAt") VALUES ($1, $2, 'Store', $1, now())`,
        [`loc-${slug}`, tenantId],
      );
      await run(
        scratch,
        `INSERT INTO "InternalUser" (id, "tenantId", "externalProvider", "externalSubject", email, "updatedAt")
         VALUES ($1, $2, 'dev', $1, $1 || '@m5b.test', now())`,
        [`user-${slug}`, tenantId],
      );
    }
  }

  it('is listed after the M5a refund foundation', () => {
    expect(at).toBeGreaterThan(
      all.findIndex((m) => m.name === '20261124090000_payment_refunds'),
    );
  });

  describe('applied', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp04_m5b_requests',
      );
      await applyMigrations(scratch.url, [...before, ...thisOne]);
      await businesses(scratch);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('a CENTERIVO refund always carries its request identity; one per request per business; it never changes', async () => {
      const paid = await paidOrder(scratch);
      const requestId = '11111111-1111-4111-8111-111111111111';
      await centerivo(scratch, paid, 'rf-1', requestId);
      // Without one, or malformed: refused.
      await expect(centerivo(scratch, paid, 'rf-2', null)).rejects.toThrow(
        /check constraint/,
      );
      await expect(
        centerivo(scratch, paid, 'rf-3', 'not-a-uuid'),
      ).rejects.toThrow(/check constraint/);
      await expect(
        centerivo(
          scratch,
          paid,
          'rf-4',
          '22222222-2222-4222-8222-222222222222',
          'short',
        ),
      ).rejects.toThrow(/check constraint/);
      // The same request id again in this business: refused.
      await expect(centerivo(scratch, paid, 'rf-5', requestId)).rejects.toThrow(
        /unique/,
      );
      // Another business may use the same id (its own request).
      const theirs = await paidOrder(scratch, OTHER);
      await centerivo(scratch, theirs, 'rf-6', requestId);
      // Never changes.
      await expect(
        run(
          scratch,
          `UPDATE "PaymentRefund" SET "clientRequestId" = '33333333-3333-4333-8333-333333333333' WHERE id = 'rf-1'`,
        ),
      ).rejects.toThrow(/request identity never changes/);
      await expect(
        run(
          scratch,
          `UPDATE "PaymentRefund" SET "requestFingerprint" = $1 WHERE id = 'rf-1'`,
          ['b'.repeat(64)],
        ),
      ).rejects.toThrow(/request identity never changes/);
      // The M5a gaps, closed: a CENTERIVO refund without its own key.
      await expect(
        run(
          scratch,
          `INSERT INTO "PaymentRefund" (id, "tenantId", "orderId", "paymentAttemptId", provider, "providerAccountId",
             origin, "amountMinorUnits", currency, "reasonCode", "requestedByInternalUserId",
             status, "clientRequestId", "requestFingerprint", "updatedAt")
           VALUES ('rf-nokey', $1, $2, $3, 'stripe', $4, 'CENTERIVO', 100, 'USD', 'CUSTOMER_REQUEST', 'user-t1',
             'REQUESTED', '44444444-4444-4444-8444-444444444444', $5, now())`,
          [T1, paid.orderId, paid.attemptId, ACCT, FINGERPRINT],
        ),
      ).rejects.toThrow(/check constraint/);
      // A refund made outside CENTERIVO carries none.
      await expect(
        run(
          scratch,
          `INSERT INTO "PaymentRefund" (id, "tenantId", "orderId", "paymentAttemptId", provider, "providerAccountId",
             origin, "amountMinorUnits", currency, status, "providerRefundId", "clientRequestId", "updatedAt")
           VALUES ('rf-ext', $1, $2, $3, 'stripe', $4, 'EXTERNAL', 100, 'USD', 'SUCCEEDED', 're_M5bMig1', $5, now())`,
          [T1, paid.orderId, paid.attemptId, ACCT, requestId],
        ),
      ).rejects.toThrow(/check constraint/);
    });

    it('when a refund was first sent is the database time, whatever the application says', async () => {
      await run(
        scratch,
        `UPDATE "PaymentRefund" SET "firstSentAt" = '2000-01-01' WHERE id = 'rf-1'`,
      );
      const { rows } = await run(
        scratch,
        `SELECT abs(extract(epoch FROM ("firstSentAt" - (now() AT TIME ZONE 'UTC'))))::int AS skew
           FROM "PaymentRefund" WHERE id = 'rf-1'`,
      );
      expect(rows[0].skew).toBeLessThan(60);
    });

    it('the rollback refuses while any CENTERIVO refund exists', async () => {
      await expect(
        applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
      ).rejects.toThrow(/rollback refused: 2 CENTERIVO refund/);
    });
  });

  it('the preflight refuses a CENTERIVO refund made before it; the rollback restores the M5a shape when none exists', async () => {
    const scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'esp04_m5b_requests_pre',
    );
    try {
      await applyMigrations(scratch.url, before);
      await businesses(scratch);
      const paid = await paidOrder(scratch);
      await run(
        scratch,
        `INSERT INTO "PaymentRefund" (id, "tenantId", "orderId", "paymentAttemptId", provider, "providerAccountId",
           origin, "amountMinorUnits", currency, "reasonCode", "requestedByInternalUserId", "idempotencyKey",
           status, "updatedAt")
         VALUES ('rf-old', $1, $2, $3, 'stripe', $4, 'CENTERIVO', 100, 'USD', 'CUSTOMER_REQUEST', 'user-t1',
           'centerivo-refund:rf-old', 'REQUESTED', now())`,
        [T1, paid.orderId, paid.attemptId, ACCT],
      );
      await expect(
        applyMigrationSql(
          scratch.url,
          readFileSync(
            join(MIGRATIONS, THIS_MIGRATION, 'migration.sql'),
            'utf8',
          ),
        ),
      ).rejects.toThrow(/without a request identity/);
      const { rows } = await run(
        scratch,
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'PaymentRefund' AND column_name = 'clientRequestId'`,
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await scratch.drop();
    }
    const clean = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'esp04_m5b_requests_rb',
    );
    try {
      await applyMigrations(clean.url, [...before, ...thisOne]);
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      const { rows } = await run(
        clean,
        `SELECT (SELECT count(*)::int FROM information_schema.columns
                  WHERE table_name = 'PaymentRefund'
                    AND column_name IN ('clientRequestId', 'requestFingerprint')) AS columns,
                to_regprocedure('payment_refund_request_identity_guard()') IS NULL AS guard_gone`,
      );
      expect(rows[0]).toEqual({ columns: 0, guard_gone: true });
    } finally {
      await clean.drop();
    }
  });
});
