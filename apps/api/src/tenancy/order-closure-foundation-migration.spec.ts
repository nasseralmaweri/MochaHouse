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

// R1 / S5a — the order closure database foundation: the REJECTED / CANCELLED
// statuses, the append-only OrderClosure, the OrderRefundObligation, the
// gift-card / loyalty reversal ledger types and the constraints and triggers
// around them. Exercised through the REAL migration SQL (and its rollback)
// against scratch databases created by the disposable-database guard, with no
// Prisma CLI spawn. NOTHING in the application writes any of this yet; the
// suite proves what the DATABASE refuses once S5b does.

jest.setTimeout(300_000);

const databasePackage = join(__dirname, '../../../../packages/database');
const migrations = listMigrations(join(databasePackage, 'prisma/migrations'));
const enumIndex = migrations.findIndex((m) =>
  m.name.endsWith('_order_closure_enum_values'),
);
const beforeAll_ = migrations.slice(0, enumIndex);
const enumValues = migrations[enumIndex];
const foundation = migrations.find((m) =>
  m.name.endsWith('_order_closure_foundation'),
)!;
const validate = migrations.find((m) =>
  m.name.endsWith('_order_closure_validate_checks'),
)!;
const rollbackSql = readFileSync(
  join(
    databasePackage,
    'prisma/rollbacks/20261019090100_order_closure_foundation.down.sql',
  ),
  'utf8',
);
const baseUrl = process.env.DATABASE_URL!;

const A = '01a0db02-f800-7000-8000-5a0000000a01';
const B = '01a0db02-f800-7000-8000-5a0000000b02';

async function run(url: string, sql: string, params: unknown[] = []) {
  return withScratchClient(url, (client) => client.query(sql, params));
}
async function rows<T = Record<string, unknown>>(
  url: string,
  sql: string,
): Promise<T[]> {
  return (await run(url, sql)).rows as T[];
}
// The SQLSTATE a statement fails with, or null when it succeeds.
async function sqlState(url: string, sql: string): Promise<string | null> {
  try {
    await run(url, sql);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}
// The SQLSTATE of a whole transaction (deferred constraints fire at COMMIT).
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

// --- fixtures (a legacy database as the application created it) ------------
const mkOrder = (n: string, tenant: string, status = 'RECEIVED') => [
  `INSERT INTO "PaymentAttempt" (id, "idempotencyKey", provider, status, amount, currency, "updatedAt", "tenantId")
   VALUES ('pa-${n}', 'key-${n}', 'fake', 'SUCCEEDED', 1500, 'USD', now(), '${tenant}')`,
  `INSERT INTO "Order" (id, "orderNumber", "accessToken", status, "locationId", "paymentAttemptId", "guestName", "guestPhone", currency, subtotal, "updatedAt", "tenantId")
   VALUES ('o-${n}', 'N-${n}', 'tok-${n}', '${status}', 'loc-${tenant}', 'pa-${n}', 'G', '555', 'USD', 1500, now(), '${tenant}')`,
];
const ORDERS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
const LEGACY_FIXTURES = [
  `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ('${A}', 'tenant-a', 'A', 'ACTIVE', now()), ('${B}', 'tenant-b', 'B', 'ACTIVE', now())`,
  `INSERT INTO "Location" (id, name, slug, "updatedAt", "tenantId") VALUES ('loc-${A}', 'LA', 'la', now(), '${A}'), ('loc-${B}', 'LB', 'lb', now(), '${B}')`,
  `INSERT INTO "InternalUser" (id, "externalProvider", email, "updatedAt", "tenantId") VALUES ('iu-a', 'internal-dev', 'a@example.test', now(), '${A}'), ('iu-b', 'internal-dev', 'b@example.test', now(), '${B}')`,
  ...ORDERS.flatMap((n) => mkOrder(n, A)),
  ...mkOrder('b1', B),
  `INSERT INTO "Customer" (id, "externalProvider", "externalSubject", email, "updatedAt", "tenantId") VALUES ('cust-a', 'dev', 'dev:a', 'c@example.test', now(), '${A}')`,
  `INSERT INTO "CustomerLoyaltyAccount" (id, "customerId", balance, "updatedAt", "tenantId") VALUES ('acct-a', 'cust-a', 100, now(), '${A}')`,
  `INSERT INTO "GiftCard" (id, "codeHash", last4, "originalValueMinorUnits", "balanceMinorUnits", "updatedAt", "tenantId") VALUES ('gc-a', 'hash-a', '0001', 5000, 5000, now(), '${A}')`,
  // existing ledger rows, in legacy shape
  `INSERT INTO "MochaBeanLedgerEntry" (id, "loyaltyAccountId", type, amount, "orderId", "tenantId") VALUES ('mb-earn-1', 'acct-a', 'EARN', 10, 'o-1', '${A}')`,
  `INSERT INTO "GiftCardTransaction" (id, "giftCardId", type, "amountMinorUnits", "balanceAfterMinorUnits", "orderId", "tenantId") VALUES ('gt-red-1', 'gc-a', 'REDEMPTION', -1000, 4000, 'o-1', '${A}')`,
];

// A well-formed closure of order `n` (status set in the same transaction).
const closure = (
  n: string,
  o: {
    tenant?: string;
    kind?: string;
    from?: string;
    refund?: number;
    actor?: string;
    reason?: string;
    note?: string | null;
  } = {},
) => {
  const tenant = o.tenant ?? A;
  const kind = o.kind ?? 'CANCELLED';
  return `INSERT INTO "OrderClosure" (id, "orderId", kind, "fromStatus", "reasonCode", note, "actorInternalUserId", "refundDueMinorUnits", "tenantId")
   VALUES ('oc-${n}', 'o-${n}', '${kind}', '${o.from ?? (kind === 'REJECTED' ? 'RECEIVED' : 'ACCEPTED')}', '${o.reason ?? 'CUSTOMER_REQUEST'}',
           ${o.note === undefined ? 'NULL' : o.note === null ? 'NULL' : `'${o.note}'`}, '${o.actor ?? (tenant === A ? 'iu-a' : 'iu-b')}', ${o.refund ?? 0}, '${tenant}')`;
};
const setStatus = (n: string, status: string) =>
  `UPDATE "Order" SET status = '${status}' WHERE id = 'o-${n}'`;
const obligation = (
  n: string,
  amount: number,
  extra = '',
  tenant: string = A,
  attempt = `pa-${n}`,
) =>
  `INSERT INTO "OrderRefundObligation" (id, "orderId", "closureId", "paymentAttemptId", "amountMinorUnits", currency, "updatedAt", "tenantId"${extra ? ', ' + extra.split('|')[0] : ''})
   VALUES ('ob-${n}', 'o-${n}', 'oc-${n}', '${attempt}', ${amount}, 'USD', now(), '${tenant}'${extra ? ', ' + extra.split('|')[1] : ''})`;

describe('R1 / S5a: order closure database foundation', () => {
  const scratches: ScratchDatabase[] = [];
  const fresh = async (label: string) => {
    const scratch = await createScratchDatabase(baseUrl, label);
    scratches.push(scratch);
    return scratch;
  };
  afterAll(async () => {
    for (const scratch of scratches) await scratch.drop();
  });

  // Legacy data present BEFORE the migrations, then everything applied.
  let db: ScratchDatabase;
  let legacyBefore: Record<string, unknown[]>;
  const snapshot = async (url: string) => ({
    orders: await rows(url, `SELECT * FROM "Order" ORDER BY id`),
    attempts: await rows(url, `SELECT * FROM "PaymentAttempt" ORDER BY id`),
    beans: await rows(url, `SELECT * FROM "MochaBeanLedgerEntry" ORDER BY id`),
    gift: await rows(url, `SELECT * FROM "GiftCardTransaction" ORDER BY id`),
    accounts: await rows(
      url,
      `SELECT * FROM "CustomerLoyaltyAccount" ORDER BY id`,
    ),
    cards: await rows(url, `SELECT * FROM "GiftCard" ORDER BY id`),
  });

  beforeAll(async () => {
    db = await fresh('s5a_populated');
    await applyMigrations(db.url, beforeAll_);
    for (const statement of LEGACY_FIXTURES) await run(db.url, statement);
    legacyBefore = await snapshot(db.url);
    await applyMigrationSql(db.url, enumValues.sql);
    await applyMigrationSql(db.url, foundation.sql);
    await applyMigrationSql(db.url, validate.sql);
  });

  describe('legacy data is untouched and existing behaviour is unchanged', () => {
    it('rewrites no order, payment, ledger, card or loyalty row', async () => {
      expect(await snapshot(db.url)).toEqual(legacyBefore);
    });

    it('creates no closed order, closure, obligation or reversal row', async () => {
      expect(
        await rows(
          db.url,
          `SELECT 1 FROM "Order" WHERE status::text IN ('REJECTED', 'CANCELLED')`,
        ),
      ).toHaveLength(0);
      expect(await rows(db.url, `SELECT 1 FROM "OrderClosure"`)).toHaveLength(
        0,
      );
      expect(
        await rows(db.url, `SELECT 1 FROM "OrderRefundObligation"`),
      ).toHaveLength(0);
    });

    it('still allows the whole existing order pipeline and ledger writes', async () => {
      for (const status of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) {
        expect(await sqlState(db.url, setStatus('12', status))).toBeNull();
      }
      // A COMPLETED order is still exactly as free to move as before this
      // change (no new freeze applies to existing statuses).
      expect(await sqlState(db.url, setStatus('12', 'READY'))).toBeNull();
      expect(
        await sqlState(
          db.url,
          `INSERT INTO "MochaBeanLedgerEntry" (id, "loyaltyAccountId", type, amount, "orderId", "tenantId")
           VALUES ('mb-redeem-ok', 'acct-a', 'REDEEM', -5, 'o-2', '${A}')`,
        ),
      ).toBeNull();
      expect(
        await sqlState(
          db.url,
          `INSERT INTO "GiftCardTransaction" (id, "giftCardId", type, "amountMinorUnits", "balanceAfterMinorUnits", "orderId", "tenantId")
           VALUES ('gt-red-ok', 'gc-a', 'REDEMPTION', -500, 3500, 'o-2', '${A}')`,
        ),
      ).toBeNull();
    });
  });

  describe('enum values', () => {
    it('adds the statuses and ledger types and keeps every existing one', async () => {
      const labels = await rows<{ t: string; l: string }>(
        db.url,
        `SELECT t.typname AS t, e.enumlabel AS l FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname IN ('OrderStatus', 'GiftCardTransactionType', 'MochaBeanEntryType')
          ORDER BY t.typname, e.enumsortorder`,
      );
      const by = (t: string) => labels.filter((r) => r.t === t).map((r) => r.l);
      expect(by('OrderStatus')).toEqual([
        'RECEIVED',
        'ACCEPTED',
        'PREPARING',
        'READY',
        'COMPLETED',
        'REJECTED',
        'CANCELLED',
      ]);
      expect(by('GiftCardTransactionType')).toEqual([
        'ISSUANCE',
        'ADJUSTMENT',
        'REDEMPTION',
        'REDEMPTION_REVERSAL',
      ]);
      expect(by('MochaBeanEntryType')).toEqual([
        'EARN',
        'MANUAL_ADJUSTMENT',
        'REDEEM',
        'BONUS_EARN',
        'REDEEM_REVERSAL',
        'EARN_REVERSAL',
        'BONUS_EARN_REVERSAL',
      ]);
    });

    it('is a file of nothing but ADD VALUE statements', () => {
      const code = enumValues.sql
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('--'));
      expect(code.length).toBe(6);
      expect(
        code.every((l) =>
          /^ALTER TYPE "\w+" ADD VALUE IF NOT EXISTS '\w+';$/.test(l),
        ),
      ).toBe(true);
    });

    it('the foundation refuses to run before the enum values exist, changing nothing', async () => {
      const scratch = await fresh('s5a_noenum');
      await applyMigrations(scratch.url, beforeAll_);
      await expect(
        applyMigrationSql(scratch.url, foundation.sql),
      ).rejects.toThrow(
        /requires migration 20261019090000_order_closure_enum_values/,
      );
      expect(
        await rows(
          scratch.url,
          `SELECT 1 FROM pg_class WHERE relname = 'OrderClosure'`,
        ),
      ).toHaveLength(0);
    });
  });

  describe('OrderClosure', () => {
    it('stores a well-formed rejection and cancellation', async () => {
      expect(
        await txState(db.url, [
          setStatus('1', 'CANCELLED'),
          closure('1', { note: 'Out of stock' }),
        ]),
      ).toBeNull();
      expect(
        await txState(db.url, [
          closure('2', { kind: 'REJECTED' }),
          setStatus('2', 'REJECTED'),
        ]),
      ).toBeNull();
    });

    it.each([
      ['an unknown kind', { kind: 'REFUNDED' }, '23514'],
      [
        'a rejection that did not start RECEIVED',
        { kind: 'REJECTED', from: 'READY' },
        '23514',
      ],
      [
        'a cancellation of a RECEIVED order',
        { kind: 'CANCELLED', from: 'RECEIVED' },
        '23514',
      ],
      [
        'a cancellation of a COMPLETED order',
        { kind: 'CANCELLED', from: 'COMPLETED' },
        '23514',
      ],
      ['a lower-case reason code', { reason: 'customer_request' }, '23514'],
      ['an empty note', { note: '' }, '23514'],
      ['a note over 500 characters', { note: 'x'.repeat(501) }, '23514'],
      ['a negative refund', { refund: -1 }, '23514'],
    ])('rejects %s', async (_label, over, state) => {
      expect(
        await sqlState(
          db.url,
          closure('3', over as Parameters<typeof closure>[1]),
        ),
      ).toBe(state);
    });

    it('allows only one closure per order (23505)', async () => {
      expect(
        await sqlState(db.url, closure('1').replace("'oc-1'", "'oc-1-dup'")),
      ).toBe('23505');
    });

    it('is append-only: UPDATE and DELETE are rejected (23001)', async () => {
      expect(
        await sqlState(
          db.url,
          `UPDATE "OrderClosure" SET note = 'edited' WHERE id = 'oc-1'`,
        ),
      ).toBe('23001');
      expect(
        await sqlState(
          db.url,
          `UPDATE "OrderClosure" SET "refundDueMinorUnits" = 9 WHERE id = 'oc-1'`,
        ),
      ).toBe('23001');
      expect(
        await sqlState(db.url, `DELETE FROM "OrderClosure" WHERE id = 'oc-1'`),
      ).toBe('23001');
    });

    it('refuses a cross-business order or actor (23503)', async () => {
      // B's staff member closing A's order, and A's staff member closing B's.
      expect(await sqlState(db.url, closure('4', { actor: 'iu-b' }))).toBe(
        '23503',
      );
      expect(
        await sqlState(db.url, closure('b1', { tenant: A, actor: 'iu-a' })),
      ).toBe('23503');
    });

    it('refuses a missing actor (23502) and an unknown order (23503)', async () => {
      expect(
        await sqlState(db.url, closure('5').replace("'iu-a'", 'NULL')),
      ).toBe('23502');
      expect(
        await sqlState(db.url, closure('5').replace("'o-5'", "'o-ghost'")),
      ).toBe('23503');
    });

    it('refuses a change of tenantId (23001 via the immutable-tenant trigger or append-only)', async () => {
      expect(
        await sqlState(
          db.url,
          `UPDATE "OrderClosure" SET "tenantId" = '${B}' WHERE id = 'oc-1'`,
        ),
      ).toBe('23001');
    });

    it('keeps a closed order from being deleted (23503)', async () => {
      expect(
        await sqlState(db.url, `DELETE FROM "Order" WHERE id = 'o-1'`),
      ).toBe('23503');
    });
  });

  describe('closure ↔ order ↔ obligation consistency (checked at COMMIT)', () => {
    it('refuses a closure whose order status does not match its kind (23000)', async () => {
      // Cancelling a closure row without moving the order.
      expect(await txState(db.url, [closure('5')])).toBe('23000');
      // Kind REJECTED but order set to CANCELLED.
      expect(
        await txState(db.url, [
          setStatus('5', 'CANCELLED'),
          closure('5', { kind: 'REJECTED' }),
        ]),
      ).toBe('23000');
    });

    it('refuses an Order that becomes REJECTED or CANCELLED without a closure (23000), and keeps it open', async () => {
      for (const status of ['CANCELLED', 'REJECTED']) {
        expect(await txState(db.url, [setStatus('4', status)])).toBe('23000');
      }
      expect(
        await rows(db.url, `SELECT status::text FROM "Order" WHERE id = 'o-4'`),
      ).toEqual([{ status: 'RECEIVED' }]);
      // With its closure, in the same transaction, it is accepted — and a
      // second move to the same status later is not a "new" closure.
      expect(
        await txState(db.url, [setStatus('4', 'CANCELLED'), closure('4')]),
      ).toBeNull();
    });

    it("ties the obligation to the closure, the order's own payment attempt, its currency and what was charged (23000)", async () => {
      const own = (extra: string[]) => [
        setStatus('3', 'CANCELLED'),
        closure('3', { refund: 1500 }),
        ...extra,
      ];
      // another order's payment attempt (same business)
      expect(
        await txState(db.url, own([obligation('3', 1500, '', A, 'pa-5')])),
      ).toBe('23000');
      // another order's closure
      expect(
        await txState(
          db.url,
          own([obligation('3', 1500).replace("'oc-3'", "'oc-1'")]),
        ),
      ).toBe('23000');
      // a different currency from the order's
      expect(
        await txState(
          db.url,
          own([obligation('3', 1500).replace("'USD'", "'EUR'")]),
        ),
      ).toBe('23000');
      // more than was charged (the attempt charged 1500)
      expect(
        await txState(db.url, [
          setStatus('3', 'CANCELLED'),
          closure('3', { refund: 2000 }),
          obligation('3', 2000),
        ]),
      ).toBe('23000');
      // the consistent version is accepted
      expect(await txState(db.url, own([obligation('3', 1500)]))).toBeNull();
    });

    it('requires an obligation exactly when money is owed, for exactly that amount', async () => {
      // Owed 1500 but no obligation.
      expect(
        await txState(db.url, [
          setStatus('6', 'CANCELLED'),
          closure('6', { refund: 1500 }),
        ]),
      ).toBe('23000');
      // Owed 1500, obligation 1000.
      expect(
        await txState(db.url, [
          setStatus('6', 'CANCELLED'),
          closure('6', { refund: 1500 }),
          obligation('6', 1000),
        ]),
      ).toBe('23000');
      // Nothing owed but an obligation exists.
      expect(
        await txState(db.url, [
          setStatus('6', 'CANCELLED'),
          closure('6', { refund: 0 }),
          obligation('6', 1500),
        ]),
      ).toBe('23000');
      // An obligation without a closure.
      expect(await txState(db.url, [obligation('6', 1500)])).toBe('23503');
      // Correct, in any statement order.
      expect(
        await txState(db.url, [
          closure('6', { refund: 1500 }),
          obligation('6', 1500),
          setStatus('6', 'CANCELLED'),
        ]),
      ).toBeNull();
    });
  });

  describe('closed orders are frozen', () => {
    it('never changes status again, to anything (23001)', async () => {
      for (const to of [
        'RECEIVED',
        'ACCEPTED',
        'PREPARING',
        'READY',
        'COMPLETED',
        'REJECTED',
      ]) {
        expect(await sqlState(db.url, setStatus('1', to))).toBe('23001');
      }
      expect(await sqlState(db.url, setStatus('2', 'CANCELLED'))).toBe('23001');
      expect(await sqlState(db.url, setStatus('2', 'RECEIVED'))).toBe('23001');
    });

    it('still lets other columns of a closed order change', async () => {
      expect(
        await sqlState(
          db.url,
          `UPDATE "Order" SET "guestName" = 'Renamed', status = 'CANCELLED' WHERE id = 'o-1'`,
        ),
      ).toBeNull();
    });

    it('does not restrict the existing statuses', async () => {
      expect(await sqlState(db.url, setStatus('7', 'ACCEPTED'))).toBeNull();
      expect(await sqlState(db.url, setStatus('7', 'RECEIVED'))).toBeNull();
    });
  });

  describe('OrderRefundObligation', () => {
    // Order 8 (no money owed) is closed once; each test uses its own order.
    const prime = async (n: string, amount = 1500) => {
      expect(
        await txState(db.url, [
          setStatus(n, 'CANCELLED'),
          closure(n, { refund: amount }),
          obligation(n, amount),
        ]),
      ).toBeNull();
    };

    it('starts DUE with no settlement data, and a refund is never implied', async () => {
      await prime('8');
      const [row] = await rows<Record<string, unknown>>(
        db.url,
        `SELECT status, "settlementMethod", "settledAt", "settledByInternalUserId", "processorRefundId" FROM "OrderRefundObligation" WHERE id = 'ob-8'`,
      );
      expect(row).toEqual({
        status: 'DUE',
        settlementMethod: null,
        settledAt: null,
        settledByInternalUserId: null,
        processorRefundId: null,
      });
    });

    it.each([
      ['REFUNDED with no method', `status = 'REFUNDED'`],
      [
        'REFUNDED with no time',
        `status = 'REFUNDED', "settlementMethod" = 'MANUAL_EXTERNAL', "settledByInternalUserId" = 'iu-a'`,
      ],
      [
        'REFUNDED manually with no staff member',
        `status = 'REFUNDED', "settlementMethod" = 'MANUAL_EXTERNAL', "settledAt" = now()`,
      ],
      [
        'REFUNDED manually while naming a processor id',
        `status = 'REFUNDED', "settlementMethod" = 'MANUAL_EXTERNAL', "settledAt" = now(), "settledByInternalUserId" = 'iu-a', "processorRefundId" = 're_1'`,
      ],
      [
        'REFUNDED by the processor with no refund id',
        `status = 'REFUNDED', "settlementMethod" = 'PROCESSOR', "settledAt" = now()`,
      ],
      [
        'REFUNDED by the processor naming a staff member',
        `status = 'REFUNDED', "settlementMethod" = 'PROCESSOR', "settledAt" = now(), "processorRefundId" = 're_1', "settledByInternalUserId" = 'iu-a'`,
      ],
      ['a settlement time without REFUNDED', `"settledAt" = now()`],
      [
        'a settlement method while DUE',
        `"settlementMethod" = 'MANUAL_EXTERNAL'`,
      ],
      ['a processor refund id while DUE', `"processorRefundId" = 're_1'`],
      [
        'PROCESSING with settlement data',
        `status = 'PROCESSING', "settlementMethod" = 'PROCESSOR'`,
      ],
      ['an unknown settlement method', `"settlementMethod" = 'CASH'`],
      [
        'an empty processor refund id',
        `status = 'PROCESSING', "processorRefundId" = ''`,
      ],
    ])('rejects %s (23514)', async (_label, set) => {
      expect(
        await sqlState(
          db.url,
          `UPDATE "OrderRefundObligation" SET ${set} WHERE id = 'ob-8'`,
        ),
      ).toBe('23514');
    });

    it('rejects an unknown status on insert (23514)', async () => {
      expect(
        await txState(db.url, [
          setStatus('12', 'CANCELLED'),
          closure('12', { refund: 1500 }),
          obligation('12', 1500, "status|'SETTLED'"),
        ]),
      ).toBe('23514');
    });

    it('rejects a non-positive amount and a malformed currency on insert (23514)', async () => {
      // (an UPDATE is stopped by the identity guard before any CHECK)
      expect(
        await sqlState(
          db.url,
          `UPDATE "OrderRefundObligation" SET "amountMinorUnits" = 0 WHERE id = 'ob-8'`,
        ),
      ).toBe('23001');
      expect(
        await txState(db.url, [
          setStatus('9', 'CANCELLED'),
          closure('9', { refund: 1500 }),
          obligation('9', 0),
        ]),
      ).toBe('23514');
      expect(
        await txState(db.url, [
          setStatus('9', 'CANCELLED'),
          closure('9', { refund: 1500 }),
          obligation('9', 1500).replace("'USD'", "'usd'"),
        ]),
      ).toBe('23514');
    });

    it('moves DUE → PROCESSING → REFUNDED through the processor, then freezes', async () => {
      await prime('9');
      expect(
        await sqlState(
          db.url,
          `UPDATE "OrderRefundObligation" SET status = 'PROCESSING', "processorRefundId" = 're_9', "updatedAt" = now() WHERE id = 'ob-9'`,
        ),
      ).toBeNull();
      // The recorded processor refund id is write-once: it cannot be changed,
      // cleared, or dropped by re-recording the refund as a manual one.
      for (const set of [
        `"processorRefundId" = 're_other'`,
        `"processorRefundId" = NULL`,
        `status = 'REFUNDED', "settlementMethod" = 'MANUAL_EXTERNAL', "settledAt" = now(), "settledByInternalUserId" = 'iu-a', "processorRefundId" = NULL`,
      ]) {
        expect(
          await sqlState(
            db.url,
            `UPDATE "OrderRefundObligation" SET ${set}, "updatedAt" = now() WHERE id = 'ob-9'`,
          ),
        ).toBe('23001');
      }
      expect(
        await sqlState(
          db.url,
          `UPDATE "OrderRefundObligation" SET status = 'REFUNDED', "settlementMethod" = 'PROCESSOR', "settledAt" = now(), "updatedAt" = now() WHERE id = 'ob-9'`,
        ),
      ).toBeNull();
      for (const set of [
        `status = 'DUE', "settlementMethod" = NULL, "settledAt" = NULL, "processorRefundId" = NULL`,
        `"settlementReference" = 'edited'`,
        `status = 'FAILED'`,
      ]) {
        expect(
          await sqlState(
            db.url,
            `UPDATE "OrderRefundObligation" SET ${set} WHERE id = 'ob-9'`,
          ),
        ).toBe('23001');
      }
      expect(
        await sqlState(
          db.url,
          `UPDATE "OrderRefundObligation" SET "updatedAt" = now() WHERE id = 'ob-9'`,
        ),
      ).toBe('23001');
    });

    it('only ever creates an obligation DUE (23001; DUE creation is exercised by every prime() above)', async () => {
      // Every non-DUE initial status is refused by the guard before any other
      // check, even one whose settlement fields would otherwise be consistent.
      for (const extra of [
        `status|'PROCESSING'`,
        `status|'FAILED'`,
        `status, "processorRefundId"|'PROCESSING', 're_new'`,
        `status, "settlementMethod", "settledAt", "settledByInternalUserId"|'REFUNDED', 'MANUAL_EXTERNAL', now(), 'iu-a'`,
      ]) {
        expect(
          await sqlState(
            db.url,
            obligation('8', 1500, extra).replace("'ob-8'", "'ob-8-new'"),
          ),
        ).toBe('23001');
      }
    });

    it('records a manual out-of-band refund only with the staff member who did it', async () => {
      await prime('10');
      expect(
        await sqlState(
          db.url,
          `UPDATE "OrderRefundObligation" SET status = 'REFUNDED', "settlementMethod" = 'MANUAL_EXTERNAL', "settledAt" = now(), "settledByInternalUserId" = 'iu-a', "settlementReference" = 'receipt 42', "updatedAt" = now() WHERE id = 'ob-10'`,
        ),
      ).toBeNull();
    });

    it('refuses a staff member of another business as the settler (23503)', async () => {
      await prime('11');
      expect(
        await sqlState(
          db.url,
          `UPDATE "OrderRefundObligation" SET status = 'REFUNDED', "settlementMethod" = 'MANUAL_EXTERNAL', "settledAt" = now(), "settledByInternalUserId" = 'iu-b', "updatedAt" = now() WHERE id = 'ob-11'`,
        ),
      ).toBe('23503');
    });

    it('never changes what the obligation is (23001) and is never deleted', async () => {
      for (const set of [
        `"amountMinorUnits" = 1`,
        `currency = 'EUR'`,
        `"orderId" = 'o-1'`,
        `"closureId" = 'oc-1'`,
        `"paymentAttemptId" = 'pa-1'`,
        `"tenantId" = '${B}'`,
      ]) {
        expect(
          await sqlState(
            db.url,
            `UPDATE "OrderRefundObligation" SET ${set} WHERE id = 'ob-8'`,
          ),
        ).toBe('23001');
      }
      expect(
        await sqlState(
          db.url,
          `DELETE FROM "OrderRefundObligation" WHERE id = 'ob-8'`,
        ),
      ).toBe('23001');
      // a DUE obligation cannot jump straight to FAILED
      expect(
        await sqlState(
          db.url,
          `UPDATE "OrderRefundObligation" SET status = 'FAILED', "updatedAt" = now() WHERE id = 'ob-8'`,
        ),
      ).toBe('23001');
    });

    it('cannot be truncated, and neither can the closure table (23001)', async () => {
      expect(
        await sqlState(
          db.url,
          `TRUNCATE "OrderClosure", "OrderRefundObligation"`,
        ),
      ).toBe('23001');
      expect(await sqlState(db.url, `TRUNCATE "OrderRefundObligation"`)).toBe(
        '23001',
      );
    });

    it('is one per order and one processor refund id per business (23505)', async () => {
      expect(
        await sqlState(
          db.url,
          obligation('8', 1500).replace("'ob-8'", "'ob-8-dup'"),
        ),
      ).toBe('23505');
      await run(
        db.url,
        `UPDATE "OrderRefundObligation" SET status = 'PROCESSING', "processorRefundId" = 're_shared', "updatedAt" = now() WHERE id = 'ob-8'`,
      );
      await run(
        db.url,
        `UPDATE "OrderRefundObligation" SET status = 'FAILED', "updatedAt" = now() WHERE id = 'ob-8'`,
      );
      // FAILED can be retried but never goes back to DUE
      expect(
        await sqlState(
          db.url,
          `UPDATE "OrderRefundObligation" SET status = 'DUE', "updatedAt" = now() WHERE id = 'ob-8'`,
        ),
      ).toBe('23001');
      expect(
        await sqlState(
          db.url,
          `UPDATE "OrderRefundObligation" SET status = 'PROCESSING', "processorRefundId" = 're_shared', "updatedAt" = now() WHERE id = 'ob-11'`,
        ),
      ).toBe('23505');
    });

    it('refuses a cross-business payment attempt, closure or order (23503)', async () => {
      expect(
        await txState(db.url, [
          setStatus('12', 'CANCELLED'),
          closure('12', { refund: 1500 }),
          obligation('12', 1500, '', A, 'pa-b1'),
        ]),
      ).toBe('23503');
    });
  });

  describe('ledger reversals', () => {
    const giftReversal = (id: string, over: Record<string, string> = {}) => {
      const v = {
        amount: '1000',
        order: "'o-1'",
        actor: "'iu-a'",
        key: 'NULL',
        reason: 'NULL',
        ...over,
      };
      return `INSERT INTO "GiftCardTransaction" (id, "giftCardId", type, "amountMinorUnits", "balanceAfterMinorUnits", "orderId", "actorInternalUserId", "operationKey", reason, "tenantId")
       VALUES ('${id}', 'gc-a', 'REDEMPTION_REVERSAL', ${v.amount}, 5000, ${v.order}, ${v.actor}, ${v.key}, ${v.reason}, '${A}')`;
    };
    const beans = (
      id: string,
      type: string,
      amount: number,
      over: Record<string, string> = {},
    ) => {
      const v = {
        order: "'o-1'",
        actor: "'iu-a'",
        key: 'NULL',
        reason: 'NULL',
        ...over,
      };
      return `INSERT INTO "MochaBeanLedgerEntry" (id, "loyaltyAccountId", type, amount, "orderId", "actorInternalUserId", "operationKey", reason, "tenantId")
       VALUES ('${id}', 'acct-a', '${type}', ${amount}, ${v.order}, ${v.actor}, ${v.key}, ${v.reason}, '${A}')`;
    };

    it('restores gift-card value once per order, as a positive entry with an actor', async () => {
      expect(await sqlState(db.url, giftReversal('gt-rev-1'))).toBeNull();
      expect(await sqlState(db.url, giftReversal('gt-rev-1b'))).toBe('23505');
      for (const over of [
        { amount: '-1000' },
        { amount: '0' },
        { order: 'NULL' },
        { actor: 'NULL' },
        { key: "'k'" },
        { reason: "'because'" },
      ] as Record<string, string>[]) {
        expect(
          await sqlState(
            db.url,
            giftReversal('gt-rev-bad', {
              ...over,
              order: over.order ?? "'o-2'",
            }),
          ),
        ).toBe('23514');
      }
      // the redemption exactly-once index is a separate, unaffected rule
      expect(
        await sqlState(
          db.url,
          `INSERT INTO "GiftCardTransaction" (id, "giftCardId", type, "amountMinorUnits", "balanceAfterMinorUnits", "orderId", "tenantId") VALUES ('gt-red-dup', 'gc-a', 'REDEMPTION', -1, 1, 'o-1', '${A}')`,
        ),
      ).toBe('23505');
    });

    it('records each loyalty reversal once per order with the right sign and an actor', async () => {
      expect(
        await sqlState(db.url, beans('mb-rr-1', 'REDEEM_REVERSAL', 5)),
      ).toBeNull();
      expect(
        await sqlState(db.url, beans('mb-er-1', 'EARN_REVERSAL', -10)),
      ).toBeNull();
      expect(
        await sqlState(db.url, beans('mb-br-1', 'BONUS_EARN_REVERSAL', -3)),
      ).toBeNull();
      // exactly-once per type per order
      expect(
        await sqlState(db.url, beans('mb-rr-dup', 'REDEEM_REVERSAL', 5)),
      ).toBe('23505');
      expect(
        await sqlState(db.url, beans('mb-er-dup', 'EARN_REVERSAL', -1)),
      ).toBe('23505');
      // wrong sign / zero
      expect(
        await sqlState(
          db.url,
          beans('s1', 'REDEEM_REVERSAL', -5, { order: "'o-2'" }),
        ),
      ).toBe('23514');
      expect(
        await sqlState(
          db.url,
          beans('s2', 'EARN_REVERSAL', 5, { order: "'o-2'" }),
        ),
      ).toBe('23514');
      expect(
        await sqlState(
          db.url,
          beans('s3', 'BONUS_EARN_REVERSAL', 0, { order: "'o-2'" }),
        ),
      ).toBe('23514');
      // no order / no actor / a key / a reason
      expect(
        await sqlState(
          db.url,
          beans('s4', 'REDEEM_REVERSAL', 5, { order: 'NULL' }),
        ),
      ).toBe('23514');
      expect(
        await sqlState(
          db.url,
          beans('s5', 'REDEEM_REVERSAL', 5, { order: "'o-2'", actor: 'NULL' }),
        ),
      ).toBe('23514');
      expect(
        await sqlState(
          db.url,
          beans('s6', 'REDEEM_REVERSAL', 5, { order: "'o-2'", key: "'k'" }),
        ),
      ).toBe('23514');
      expect(
        await sqlState(
          db.url,
          beans('s7', 'REDEEM_REVERSAL', 5, { order: "'o-2'", reason: "'r'" }),
        ),
      ).toBe('23514');
    });

    it('does not constrain the existing ledger types', async () => {
      expect(
        await sqlState(
          db.url,
          `INSERT INTO "MochaBeanLedgerEntry" (id, "loyaltyAccountId", type, amount, reason, "operationKey", "actorInternalUserId", "tenantId")
           VALUES ('mb-adj', 'acct-a', 'MANUAL_ADJUSTMENT', -7, 'goodwill', 'op-1', 'iu-a', '${A}')`,
        ),
      ).toBeNull();
    });

    it('refuses a cross-business order or actor on a reversal (23503)', async () => {
      expect(
        await sqlState(db.url, giftReversal('gt-x', { order: "'o-b1'" })),
      ).toBe('23503');
      expect(
        await sqlState(
          db.url,
          giftReversal('gt-y', { order: "'o-3'", actor: "'iu-b'" }),
        ),
      ).toBe('23503');
    });
  });

  describe('tenant scoping of the new tables', () => {
    it('every new table is tenant-scoped, composite-keyed and tenant-immutable', async () => {
      const cols = await rows<{ t: string; n: string }>(
        db.url,
        `SELECT table_name AS t, is_nullable AS n FROM information_schema.columns
          WHERE table_name IN ('OrderClosure', 'OrderRefundObligation') AND column_name = 'tenantId'
          ORDER BY 1`,
      );
      expect(cols).toEqual([
        { t: 'OrderClosure', n: 'NO' },
        { t: 'OrderRefundObligation', n: 'NO' },
      ]);
      const triggers = await rows<{ n: string }>(
        db.url,
        `SELECT tgname AS n FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('OrderClosure_tenantId_immutable', 'OrderRefundObligation_tenantId_immutable') ORDER BY 1`,
      );
      expect(triggers.map((t) => t.n)).toEqual([
        'OrderClosure_tenantId_immutable',
        'OrderRefundObligation_tenantId_immutable',
      ]);
      const composite = await rows<{ n: string }>(
        db.url,
        `SELECT conname AS n FROM pg_constraint
          WHERE contype = 'f' AND conrelid IN ('"OrderClosure"'::regclass, '"OrderRefundObligation"'::regclass)
            AND array_length(conkey, 1) = 2
          ORDER BY 1`,
      );
      expect(composite.map((c) => c.n)).toEqual([
        'OrderClosure_tenantId_actorInternalUserId_fkey',
        'OrderClosure_tenantId_orderId_fkey',
        'OrderRefundObligation_tenantId_closureId_fkey',
        'OrderRefundObligation_tenantId_orderId_fkey',
        'OrderRefundObligation_tenantId_paymentAttemptId_fkey',
        'OrderRefundObligation_tenantId_settledByInternalUserId_fkey',
      ]);
    });

    it('refuses a tenantId change on an obligation (23001)', async () => {
      expect(
        await sqlState(
          db.url,
          `UPDATE "OrderRefundObligation" SET "tenantId" = '${B}' WHERE id = 'ob-8'`,
        ),
      ).toBe('23001');
    });
  });

  describe('ledger CHECKs: NOT VALID first, validated without a long lock', () => {
    const state = (url: string) =>
      rows<{ n: string; v: boolean }>(
        url,
        `SELECT conname AS n, convalidated AS v FROM pg_constraint
          WHERE conname IN ('GiftCardTransaction_redemption_reversal_check', 'MochaBeanLedgerEntry_reversal_check')
          ORDER BY 1`,
      );

    it('adds both NOT VALID (enforced for writes), then the second migration validates them', async () => {
      const scratch = await fresh('s5a_notvalid');
      await applyMigrations(scratch.url, beforeAll_);
      for (const statement of LEGACY_FIXTURES)
        await run(scratch.url, statement);
      await applyMigrationSql(scratch.url, enumValues.sql);
      await applyMigrationSql(scratch.url, foundation.sql);
      expect(await state(scratch.url)).toEqual([
        { n: 'GiftCardTransaction_redemption_reversal_check', v: false },
        { n: 'MochaBeanLedgerEntry_reversal_check', v: false },
      ]);
      expect(
        await sqlState(
          scratch.url,
          `INSERT INTO "MochaBeanLedgerEntry" (id, "loyaltyAccountId", type, amount, "tenantId") VALUES ('x', 'acct-a', 'EARN_REVERSAL', 3, '${A}')`,
        ),
      ).toBe('23514');
      expect(
        await sqlState(
          scratch.url,
          `INSERT INTO "GiftCardTransaction" (id, "giftCardId", type, "amountMinorUnits", "balanceAfterMinorUnits", "orderId", "actorInternalUserId", "tenantId") VALUES ('gx', 'gc-a', 'REDEMPTION_REVERSAL', -5, 1, 'o-2', 'iu-a', '${A}')`,
        ),
      ).toBe('23514');
      const before = await snapshot(scratch.url);
      await applyMigrationSql(scratch.url, validate.sql);
      expect(await state(scratch.url)).toEqual([
        { n: 'GiftCardTransaction_redemption_reversal_check', v: true },
        { n: 'MochaBeanLedgerEntry_reversal_check', v: true },
      ]);
      expect(await snapshot(scratch.url)).toEqual(before);
      await applyMigrationSql(scratch.url, validate.sql);
    });

    it('the validation migration refuses to run without the foundation, changing nothing', async () => {
      const scratch = await fresh('s5a_novalidate');
      await applyMigrations(scratch.url, beforeAll_);
      await applyMigrationSql(scratch.url, enumValues.sql);
      await expect(
        applyMigrationSql(scratch.url, validate.sql),
      ).rejects.toThrow(/requires the foundation migration/);
    });

    it('takes no lock that blocks writes while validating (SHARE UPDATE EXCLUSIVE only)', () => {
      const code = validate.sql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
      expect(code).toMatch(
        /VALIDATE CONSTRAINT "GiftCardTransaction_redemption_reversal_check"/,
      );
      expect(code).toMatch(
        /VALIDATE CONSTRAINT "MochaBeanLedgerEntry_reversal_check"/,
      );
      expect(code).not.toMatch(
        /ADD COLUMN|ADD CONSTRAINT|UPDATE|DROP|DELETE|CREATE/,
      );
    });
  });

  describe('fresh database', () => {
    it('applies every migration cleanly and leaves the new tables empty', async () => {
      const scratch = await fresh('s5a_fresh');
      await applyMigrations(scratch.url, migrations);
      expect(
        await rows(scratch.url, `SELECT 1 FROM "OrderClosure"`),
      ).toHaveLength(0);
      expect(
        await rows(scratch.url, `SELECT 1 FROM "OrderRefundObligation"`),
      ).toHaveLength(0);
      const triggers = await rows<{ n: string }>(
        scratch.url,
        `SELECT tgname AS n FROM pg_trigger WHERE NOT tgisinternal
          AND tgname IN ('Order_closure_required', 'Order_closed_status_frozen', 'OrderClosure_consistent',
                         'OrderRefundObligation_consistent', 'OrderClosure_append_only', 'OrderRefundObligation_guard',
                         'OrderClosure_no_truncate', 'OrderRefundObligation_no_truncate') ORDER BY 1`,
      );
      expect(triggers).toHaveLength(8);
      const idx = await rows<{ indexdef: string }>(
        scratch.url,
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'GiftCardTransaction_orderId_redemption_reversal_key'`,
      );
      expect(idx).toHaveLength(1);
      expect(idx[0].indexdef).toMatch(
        /UNIQUE.*\("orderId"\).*WHERE.*REDEMPTION_REVERSAL/,
      );
    });
  });

  describe('rollback and re-apply', () => {
    it('rolls back the tables, triggers, functions and indexes; the enum values remain', async () => {
      const scratch = await fresh('s5a_rollback');
      await applyMigrations(scratch.url, migrations);
      await applyMigrationSql(scratch.url, rollbackSql);
      const left = await rows<{ n: string }>(
        scratch.url,
        `SELECT relname AS n FROM pg_class WHERE relname IN ('OrderClosure', 'OrderRefundObligation', 'GiftCardTransaction_orderId_redemption_reversal_key')
         UNION ALL SELECT proname FROM pg_proc WHERE proname IN ('reject_order_closure_change', 'guard_order_refund_obligation_change', 'assert_order_closure_consistent', 'reject_closed_order_status_change', 'reject_order_closure_truncate')
         UNION ALL SELECT tgname FROM pg_trigger WHERE tgname = 'Order_closed_status_frozen'
         UNION ALL SELECT conname FROM pg_constraint WHERE conname IN ('GiftCardTransaction_redemption_reversal_check', 'MochaBeanLedgerEntry_reversal_check')`,
      );
      expect(left).toEqual([]);
      // Postgres cannot drop enum values: they stay, unused.
      expect(
        await rows(
          scratch.url,
          `SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'OrderStatus' AND e.enumlabel = 'CANCELLED'`,
        ),
      ).toHaveLength(1);
      // ...and the foundation can be applied again.
      await applyMigrationSql(scratch.url, foundation.sql);
      await applyMigrationSql(scratch.url, validate.sql);
      expect(
        await rows(scratch.url, `SELECT 1 FROM "OrderClosure"`),
      ).toHaveLength(0);
    });

    it.each([
      ['an order was closed', null],
      ['a gift-card restoration exists', null],
      ['a loyalty reversal exists', null],
    ])('refuses to roll back once %s, changing nothing', async (label) => {
      const scratch = await fresh('s5a_refuse');
      await applyMigrations(scratch.url, beforeAll_);
      for (const statement of LEGACY_FIXTURES)
        await run(scratch.url, statement);
      await applyMigrationSql(scratch.url, enumValues.sql);
      await applyMigrationSql(scratch.url, foundation.sql);
      if (label === 'an order was closed') {
        expect(
          await txState(scratch.url, [
            setStatus('1', 'CANCELLED'),
            closure('1'),
          ]),
        ).toBeNull();
      } else if (label === 'a gift-card restoration exists') {
        await run(
          scratch.url,
          `INSERT INTO "GiftCardTransaction" (id, "giftCardId", type, "amountMinorUnits", "balanceAfterMinorUnits", "orderId", "actorInternalUserId", "tenantId")
           VALUES ('gt-r', 'gc-a', 'REDEMPTION_REVERSAL', 1000, 6000, 'o-1', 'iu-a', '${A}')`,
        );
      } else {
        await run(
          scratch.url,
          `INSERT INTO "MochaBeanLedgerEntry" (id, "loyaltyAccountId", type, amount, "orderId", "actorInternalUserId", "tenantId")
           VALUES ('mb-r', 'acct-a', 'REDEEM_REVERSAL', 5, 'o-1', 'iu-a', '${A}')`,
        );
      }
      await expect(applyMigrationSql(scratch.url, rollbackSql)).rejects.toThrow(
        /rollback refused/,
      );
      expect(
        await rows(
          scratch.url,
          `SELECT 1 FROM pg_class WHERE relname = 'OrderClosure'`,
        ),
      ).toHaveLength(1);
    });

    it('a second apply on an already migrated database aborts without changes', async () => {
      const before = await snapshot(db.url);
      await expect(applyMigrationSql(db.url, foundation.sql)).rejects.toThrow(
        /already exists/,
      );
      expect(await snapshot(db.url)).toEqual(before);
    });
  });
});
