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

// R1 / S5b — the database guards that must exist before REJECTED / CANCELLED can
// be written (migration 20261020090000_order_closure_writer_guards):
//   - Invariant 2: no Order is ever INSERTED already closed — plain INSERT,
//     INSERT ... SELECT, INSERT ... ON CONFLICT and COPY all hit the guard;
//   - a manual refund needs evidence (settlementReference) and a second person
//     (not the staff member who closed the order).
// Exercised through the REAL migration SQL and its rollback on scratch
// databases.

jest.setTimeout(300_000);

const databasePackage = join(__dirname, '../../../../packages/database');
const migrations = listMigrations(join(databasePackage, 'prisma/migrations'));
const guardsIndex = migrations.findIndex((m) =>
  m.name.endsWith('_order_closure_writer_guards'),
);
const beforeGuards = migrations.slice(0, guardsIndex);
const guards = migrations[guardsIndex];
const rollbackSql = readFileSync(
  join(
    databasePackage,
    'prisma/rollbacks/20261020090000_order_closure_writer_guards.down.sql',
  ),
  'utf8',
);
const baseUrl = process.env.DATABASE_URL!;

const A = '01a0db02-f800-7000-8000-5b0000000a11';

async function run(url: string, sql: string) {
  return withScratchClient(url, (client) => client.query(sql));
}
async function rows<T = Record<string, unknown>>(
  url: string,
  sql: string,
): Promise<T[]> {
  return (await run(url, sql)).rows as T[];
}
async function sqlState(url: string, sql: string): Promise<string | null> {
  try {
    await run(url, sql);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}
async function txState(
  url: string,
  statements: string[],
): Promise<string | null> {
  return withScratchClient(url, async (client: Client) => {
    await client.query('BEGIN');
    try {
      for (const statement of statements) await client.query(statement);
      await client.query('COMMIT');
      return null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return (error as { code?: string }).code ?? 'unknown';
    }
  });
}

const attempt = (n: string, amount = 1500) =>
  `INSERT INTO "PaymentAttempt" (id, "idempotencyKey", provider, status, amount, currency, "providerReference", "updatedAt", "tenantId")
   VALUES ('pa-${n}', 'key-${n}', 'fake', 'SUCCEEDED', ${amount}, 'USD', 'ref-${n}', now(), '${A}')`;
const orderColumns = `id, "orderNumber", "accessToken", status, "locationId", "paymentAttemptId", "guestName", "guestPhone", currency, subtotal, "updatedAt", "tenantId"`;
const orderValues = (n: string, status: string) =>
  `('o-${n}', 'N-${n}', 'tok-${n}', '${status}', 'loc-a', 'pa-${n}', 'G', '555', 'USD', 1500, now(), '${A}')`;
const order = (n: string, status = 'RECEIVED') =>
  `INSERT INTO "Order" (${orderColumns}) VALUES ${orderValues(n, status)}`;

const FIXTURES = [
  `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ('${A}', 'tenant-a', 'A', 'ACTIVE', now())`,
  `INSERT INTO "Location" (id, name, slug, "updatedAt", "tenantId") VALUES ('loc-a', 'LA', 'la', now(), '${A}')`,
  `INSERT INTO "InternalUser" (id, "externalProvider", email, "updatedAt", "tenantId") VALUES
     ('iu-closer', 'internal-dev', 'closer@example.test', now(), '${A}'),
     ('iu-second', 'internal-dev', 'second@example.test', now(), '${A}')`,
];

// A cancelled order with its closure and a DUE refund obligation, written the
// way the closure writer writes them (one transaction).
const cancelledWithObligation = (n: string) => [
  attempt(n),
  order(n, 'ACCEPTED'),
];
const closeIt = (n: string) => [
  `UPDATE "Order" SET status = 'CANCELLED' WHERE id = 'o-${n}'`,
  `INSERT INTO "OrderClosure" (id, "orderId", kind, "fromStatus", "reasonCode", "actorInternalUserId", "refundDueMinorUnits", "tenantId")
   VALUES ('oc-${n}', 'o-${n}', 'CANCELLED', 'ACCEPTED', 'CUSTOMER_REQUEST', 'iu-closer', 1500, '${A}')`,
  `INSERT INTO "OrderRefundObligation" (id, "orderId", "closureId", "paymentAttemptId", "amountMinorUnits", currency, "updatedAt", "tenantId")
   VALUES ('ob-${n}', 'o-${n}', 'oc-${n}', 'pa-${n}', 1500, 'USD', now(), '${A}')`,
];
const settle = (n: string, set: string) =>
  `UPDATE "OrderRefundObligation" SET ${set}, "updatedAt" = now() WHERE id = 'ob-${n}'`;

describe('R1 / S5b: order closure writer guards (migration)', () => {
  const scratches: ScratchDatabase[] = [];
  const fresh = async (label: string) => {
    const scratch = await createScratchDatabase(baseUrl, label);
    scratches.push(scratch);
    return scratch;
  };
  afterAll(async () => {
    for (const scratch of scratches) await scratch.drop();
  });

  let db: ScratchDatabase;
  beforeAll(async () => {
    db = await fresh('s5b_guards');
    await applyMigrations(db.url, beforeGuards);
    for (const statement of FIXTURES) await run(db.url, statement);
    // An open order that exists before the guard: untouched by it.
    await run(db.url, attempt('legacy'));
    await run(db.url, order('legacy', 'READY'));
    await applyMigrationSql(db.url, guards.sql);
  });

  describe('Invariant 2: an order is never born closed', () => {
    it.each(['REJECTED', 'CANCELLED'])(
      'a plain INSERT of a %s order is refused',
      async (status) => {
        await run(db.url, attempt(`plain-${status}`));
        expect(await sqlState(db.url, order(`plain-${status}`, status))).toBe(
          '23001',
        );
      },
    );

    it.each(['RECEIVED', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED'])(
      'an INSERT of a %s order is still allowed',
      async (status) => {
        await run(db.url, attempt(`open-${status}`));
        expect(
          await sqlState(db.url, order(`open-${status}`, status)),
        ).toBeNull();
      },
    );

    it('INSERT ... SELECT of a closed order is refused', async () => {
      await run(db.url, attempt('sel'));
      expect(
        await sqlState(
          db.url,
          `INSERT INTO "Order" (${orderColumns})
           SELECT 'o-sel', 'N-sel', 'tok-sel', 'CANCELLED'::"OrderStatus", 'loc-a', 'pa-sel', 'G', '555', 'USD', 1500, now(), '${A}'`,
        ),
      ).toBe('23001');
    });

    it('INSERT ... ON CONFLICT DO NOTHING of a closed order is refused (the row trigger fires before the conflict check)', async () => {
      await run(db.url, attempt('conf1'));
      expect(
        await sqlState(
          db.url,
          `INSERT INTO "Order" (${orderColumns}) VALUES ${orderValues('conf1', 'REJECTED')} ON CONFLICT DO NOTHING`,
        ),
      ).toBe('23001');
      // ...also when the row DOES conflict with an existing order.
      expect(
        await sqlState(
          db.url,
          `INSERT INTO "Order" (${orderColumns}) VALUES ${orderValues('legacy', 'CANCELLED')} ON CONFLICT (id) DO NOTHING`,
        ),
      ).toBe('23001');
    });

    it('INSERT ... ON CONFLICT DO UPDATE cannot close an existing order without a closure', async () => {
      // The insert half is an open order; the DO UPDATE half tries to close the
      // existing one. That is an UPDATE: S5a's commit-time check refuses it.
      expect(
        await sqlState(
          db.url,
          `INSERT INTO "Order" (${orderColumns}) VALUES ${orderValues('legacy', 'RECEIVED')}
           ON CONFLICT (id) DO UPDATE SET status = 'CANCELLED'`,
        ),
      ).toBe('23000');
      expect(
        await rows(
          db.url,
          `SELECT status::text AS s FROM "Order" WHERE id = 'o-legacy'`,
        ),
      ).toEqual([{ s: 'READY' }]);
    });

    it('COPY of a closed order is refused (row triggers fire for COPY FROM)', async () => {
      await run(db.url, attempt('copy'));
      const line = `o-copy,N-copy,tok-copy,CANCELLED,loc-a,pa-copy,G,555,USD,1500,2026-10-20 00:00:00,${A}`;
      expect(
        await sqlState(
          db.url,
          `COPY "Order" (${orderColumns}) FROM PROGRAM 'printf "%s\\n" "${line}"' WITH (FORMAT csv)`,
        ),
      ).toBe('23001');
      expect(
        await rows(db.url, `SELECT 1 FROM "Order" WHERE id = 'o-copy'`),
      ).toHaveLength(0);
      // ...while COPY of an open order still works.
      await run(db.url, attempt('copy2'));
      const open = `o-copy2,N-copy2,tok-copy2,RECEIVED,loc-a,pa-copy2,G,555,USD,1500,2026-10-20 00:00:00,${A}`;
      expect(
        await sqlState(
          db.url,
          `COPY "Order" (${orderColumns}) FROM PROGRAM 'printf "%s\\n" "${open}"' WITH (FORMAT csv)`,
        ),
      ).toBeNull();
    });

    it('the guard is an enabled, row-level BEFORE INSERT trigger (so it covers every insert path)', async () => {
      const [t] = await rows<{ tgtype: number; tgenabled: string }>(
        db.url,
        `SELECT tgtype, tgenabled FROM pg_trigger WHERE tgname = 'Order_insert_not_closed'`,
      );
      // tgtype bits: 1 = ROW, 2 = BEFORE, 4 = INSERT
      expect(t.tgtype & 7).toBe(7);
      expect(t.tgenabled).toBe('O');
    });

    it('the closure workflow itself (update + closure + obligation in one transaction) still works', async () => {
      for (const s of cancelledWithObligation('wf')) await run(db.url, s);
      expect(await txState(db.url, closeIt('wf'))).toBeNull();
    });
  });

  describe('a manual refund needs evidence and a second person', () => {
    beforeAll(async () => {
      for (const n of ['m1', 'm2', 'm3', 'm4']) {
        for (const s of cancelledWithObligation(n)) await run(db.url, s);
        expect(await txState(db.url, closeIt(n))).toBeNull();
      }
    });

    it('refuses MANUAL_EXTERNAL settlement without a reference', async () => {
      expect(
        await sqlState(
          db.url,
          settle(
            'm1',
            `status = 'REFUNDED', "settlementMethod" = 'MANUAL_EXTERNAL', "settledAt" = now(), "settledByInternalUserId" = 'iu-second'`,
          ),
        ),
      ).toBe('23514');
    });

    it('refuses MANUAL_EXTERNAL settlement by the staff member who closed the order', async () => {
      expect(
        await sqlState(
          db.url,
          settle(
            'm2',
            `status = 'REFUNDED', "settlementMethod" = 'MANUAL_EXTERNAL', "settledAt" = now(), "settledByInternalUserId" = 'iu-closer', "settlementReference" = 'terminal ref 9912'`,
          ),
        ),
      ).toBe('23001');
    });

    it('accepts MANUAL_EXTERNAL settlement with a reference by a second person', async () => {
      expect(
        await sqlState(
          db.url,
          settle(
            'm3',
            `status = 'REFUNDED', "settlementMethod" = 'MANUAL_EXTERNAL', "settledAt" = now(), "settledByInternalUserId" = 'iu-second', "settlementReference" = 'terminal ref 9913'`,
          ),
        ),
      ).toBeNull();
    });

    it('PROCESSOR settlement still needs only the processor refund id', async () => {
      expect(
        await sqlState(
          db.url,
          settle('m4', `status = 'PROCESSING', "processorRefundId" = 're_m4'`),
        ),
      ).toBeNull();
      expect(
        await sqlState(
          db.url,
          settle(
            'm4',
            `status = 'REFUNDED', "settlementMethod" = 'PROCESSOR', "settledAt" = now()`,
          ),
        ),
      ).toBeNull();
    });
  });

  describe('applying', () => {
    it('applies cleanly on a fresh database with every migration', async () => {
      const scratch = await fresh('s5b_fresh');
      await applyMigrations(scratch.url, migrations);
      const objects = await rows<{ n: string }>(
        scratch.url,
        `SELECT tgname AS n FROM pg_trigger WHERE tgname IN ('Order_insert_not_closed', 'OrderRefundObligation_settler_not_closer')
         UNION ALL SELECT conname FROM pg_constraint WHERE conname = 'OrderRefundObligation_manual_evidence_check' AND convalidated
         ORDER BY 1`,
      );
      expect(objects.map((o) => o.n)).toEqual([
        'OrderRefundObligation_manual_evidence_check',
        'OrderRefundObligation_settler_not_closer',
        'Order_insert_not_closed',
      ]);
    });

    it('a second apply aborts without changes', async () => {
      await expect(applyMigrationSql(db.url, guards.sql)).rejects.toThrow(
        /already exists/,
      );
    });

    it('refuses to apply over a closed order that has no closure', async () => {
      const scratch = await fresh('s5b_preflight');
      await applyMigrations(scratch.url, beforeGuards);
      for (const statement of FIXTURES) await run(scratch.url, statement);
      await run(scratch.url, attempt('x'));
      // Possible before this guard: an order inserted already closed.
      await run(scratch.url, order('x', 'CANCELLED'));
      await expect(applyMigrationSql(scratch.url, guards.sql)).rejects.toThrow(
        /without a matching closure/,
      );
      expect(
        await rows(
          scratch.url,
          `SELECT 1 FROM pg_trigger WHERE tgname = 'Order_insert_not_closed'`,
        ),
      ).toHaveLength(0);
    });
  });

  describe('rollback', () => {
    it('removes exactly what the migration added, and it can be applied again', async () => {
      const scratch = await fresh('s5b_rollback');
      await applyMigrations(scratch.url, migrations);
      await applyMigrationSql(scratch.url, rollbackSql);
      const left = await rows(
        scratch.url,
        `SELECT tgname FROM pg_trigger WHERE tgname IN ('Order_insert_not_closed', 'OrderRefundObligation_settler_not_closer')
         UNION ALL SELECT proname FROM pg_proc WHERE proname IN ('reject_closed_order_insert', 'reject_self_settled_order_refund')
         UNION ALL SELECT conname FROM pg_constraint WHERE conname = 'OrderRefundObligation_manual_evidence_check'`,
      );
      expect(left).toEqual([]);
      // S5a's guards are untouched.
      expect(
        await rows(
          scratch.url,
          `SELECT 1 FROM pg_trigger WHERE tgname IN ('Order_closure_required', 'Order_closed_status_frozen')`,
        ),
      ).toHaveLength(2);
      await applyMigrationSql(scratch.url, guards.sql);
    });

    it('refuses once any order is closed: the guard must stay', async () => {
      await expect(applyMigrationSql(db.url, rollbackSql)).rejects.toThrow(
        /rollback refused/,
      );
      expect(
        await rows(
          db.url,
          `SELECT 1 FROM pg_trigger WHERE tgname = 'Order_insert_not_closed'`,
        ),
      ).toHaveLength(1);
    });
  });
});
