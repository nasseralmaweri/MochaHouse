import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';

// ESP-04 M5a — migration 20261124090000_payment_refunds on scratch databases.
// Every rule is the DATABASE's (nothing here goes through application code):
// a refund belongs, with its order, payment and staff, to one business; it is
// only for a confirmed Stripe payment of that order, on its account, in its
// currency, and (from CENTERIVO) only for a completed or closed order; it can
// never take the refunds of a payment over what was charged, even with two
// requests at once; its identity, Stripe id and times are protected; its
// status moves only forward; its history is written by the database and is
// append-only; a late failure blocks new refunds until reviewed; an
// obligation is settled only when fully and finally refunded and never by
// hand for a Stripe payment; an order is not closed while a refund is in
// flight; existing businesses get the permission and the access level; and
// the rollback and preflight refuse what they must.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const THIS_MIGRATION = '20261124090000_payment_refunds';
const ROLLBACK = join(
  __dirname,
  `../../../../packages/database/prisma/rollbacks/${THIS_MIGRATION}.down.sql`,
);
const T1 = TENANT_1_MOCHA_HOUSE_ID;
const OTHER = '01a0db02-f800-7000-8000-c5a0000000c9';
const ACCT = 'acct_1M5aTest';
const OTHER_ACCT = 'acct_1M5aOther';

jest.setTimeout(300_000);

type Row = Record<string, unknown>;

describe('ESP-04 M5a payment refunds migration (scratch database)', () => {
  const all = listMigrations(MIGRATIONS);
  const at = all.findIndex((m) => m.name === THIS_MIGRATION);
  const before = all.slice(0, at);
  const thisOne = all.slice(at, at + 1);

  const run = (
    scratch: ScratchDatabase,
    text: string,
    params: unknown[] = [],
  ) => withScratchClient(scratch.url, (c) => c.query<Row>(text, params));
  const inTransaction = (
    scratch: ScratchDatabase,
    statements: Array<[string, unknown[]?]>,
  ) =>
    withScratchClient(scratch.url, async (c) => {
      await c.query('BEGIN');
      try {
        for (const [text, params] of statements)
          await c.query(text, params ?? []);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      }
    });

  // --- fixtures ---------------------------------------------------------------
  let sequence = 0;
  const next = (prefix: string) => `${prefix}-${++sequence}`;

  const business = async (
    scratch: ScratchDatabase,
    tenantId: string,
    slug: string,
  ) => {
    await run(
      scratch,
      `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt")
       VALUES ($1, $2, $2, 'ACTIVE', now()) ON CONFLICT (id) DO NOTHING`,
      [tenantId, slug],
    );
    await run(
      scratch,
      `INSERT INTO "Location" (id, "tenantId", name, slug, "updatedAt")
       VALUES ($1, $2, 'Store', $3, now())`,
      [`loc-${slug}`, tenantId, `store-${slug}`],
    );
    for (const who of ['owner', 'manager']) {
      await run(
        scratch,
        `INSERT INTO "InternalUser" (id, "tenantId", "externalProvider", "externalSubject", email, "updatedAt")
         VALUES ($1, $2, 'dev', $1, $3, now())`,
        [`${who}-${slug}`, tenantId, `${who}@${slug}.test`],
      );
    }
  };

  interface Paid {
    attemptId: string;
    orderId: string;
    tenantId: string;
  }
  const paidOrder = async (
    scratch: ScratchDatabase,
    values: {
      tenantId?: string;
      slug?: string;
      amount?: number;
      provider?: string;
      status?: string;
      orderStatus?: string;
      reconciliationRequired?: boolean;
    } = {},
  ): Promise<Paid> => {
    const tenantId = values.tenantId ?? T1;
    const slug = values.slug ?? 't1';
    const amount = values.amount ?? 1000;
    const provider = values.provider ?? 'stripe';
    const attemptId = next('pa');
    const orderId = next('order');
    await run(
      scratch,
      `INSERT INTO "PaymentAttempt" (id, "tenantId", "idempotencyKey", provider, amount, currency, status,
         "paymentState", "providerReference", "providerAccountId", "reconciliationRequired", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 'USD', $6::"PaymentAttemptStatus", $7, $8, $9, $10, now())`,
      [
        attemptId,
        tenantId,
        `key-${attemptId}`,
        provider,
        amount,
        values.status ?? 'SUCCEEDED',
        provider === 'stripe' ? 'SUCCEEDED' : null,
        provider === 'stripe'
          ? `pi_${attemptId.replace(/-/g, '')}`
          : `fake_${attemptId}`,
        provider === 'stripe' ? (tenantId === T1 ? ACCT : OTHER_ACCT) : null,
        values.reconciliationRequired ?? false,
      ],
    );
    await run(
      scratch,
      `INSERT INTO "Order" (id, "tenantId", "orderNumber", "accessToken", "locationId", "paymentAttemptId",
         "guestName", "guestPhone", subtotal, currency, status, "updatedAt")
       VALUES ($1, $2, $1, $1, $3, $4, 'Guest', '5550000000', $5, 'USD', $6::"OrderStatus", now())`,
      [
        orderId,
        tenantId,
        `loc-${slug}`,
        attemptId,
        amount,
        values.orderStatus ?? 'COMPLETED',
      ],
    );
    return { attemptId, orderId, tenantId };
  };

  // Cancels an ACCEPTED order through the closure rows (what S5b writes):
  // a DUE obligation for the whole card amount.
  const cancelWithObligation = async (
    scratch: ScratchDatabase,
    paid: Paid,
    amount = 1000,
  ) => {
    const closureId = next('closure');
    const obligationId = next('obligation');
    const slug = paid.tenantId === T1 ? 't1' : 'other';
    await inTransaction(scratch, [
      [`UPDATE "Order" SET status = 'CANCELLED' WHERE id = $1`, [paid.orderId]],
      [
        `INSERT INTO "OrderClosure" (id, "tenantId", "orderId", kind, "fromStatus", "reasonCode",
           "actorInternalUserId", "refundDueMinorUnits")
         VALUES ($1, $2, $3, 'CANCELLED', 'ACCEPTED', 'CUSTOMER_REQUEST', $4, $5)`,
        [closureId, paid.tenantId, paid.orderId, `manager-${slug}`, amount],
      ],
      [
        `INSERT INTO "OrderRefundObligation" (id, "tenantId", "orderId", "closureId", "paymentAttemptId",
           "amountMinorUnits", currency, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, 'USD', now())`,
        [
          obligationId,
          paid.tenantId,
          paid.orderId,
          closureId,
          paid.attemptId,
          amount,
        ],
      ],
    ]);
    return obligationId;
  };

  const refund = (
    scratch: ScratchDatabase,
    paid: Paid,
    values: {
      id?: string;
      origin?: 'CENTERIVO' | 'EXTERNAL';
      amount?: number;
      status?: string;
      providerRefundId?: string | null;
      account?: string;
      currency?: string;
      tenantId?: string;
      orderId?: string;
      requestedBy?: string | null;
    } = {},
  ) => {
    const id = values.id ?? next('rf');
    const origin = values.origin ?? 'CENTERIVO';
    const slug = paid.tenantId === T1 ? 't1' : 'other';
    const centerivo = origin === 'CENTERIVO';
    return run(
      scratch,
      `INSERT INTO "PaymentRefund" (id, "tenantId", "orderId", "paymentAttemptId", provider, "providerAccountId",
         origin, "amountMinorUnits", currency, "reasonCode", "requestedByInternalUserId", "idempotencyKey",
         status, "providerRefundId", "updatedAt")
       VALUES ($1, $2, $3, $4, 'stripe', $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
       RETURNING id`,
      [
        id,
        values.tenantId ?? paid.tenantId,
        values.orderId ?? paid.orderId,
        paid.attemptId,
        values.account ?? (paid.tenantId === T1 ? ACCT : OTHER_ACCT),
        origin,
        values.amount ?? 100,
        values.currency ?? 'USD',
        centerivo ? 'CUSTOMER_REQUEST' : null,
        centerivo
          ? values.requestedBy === undefined
            ? `manager-${slug}`
            : values.requestedBy
          : null,
        centerivo ? `centerivo-refund:${id}` : null,
        values.status ?? (centerivo ? 'REQUESTED' : 'SUCCEEDED'),
        values.providerRefundId === undefined
          ? centerivo
            ? null
            : `re_${id.replace(/-/g, '')}`
          : values.providerRefundId,
      ],
    ).then(() => id);
  };
  const setRefund = (
    scratch: ScratchDatabase,
    id: string,
    sets: string,
    params: unknown[] = [],
  ) =>
    run(scratch, `UPDATE "PaymentRefund" SET ${sets} WHERE id = $1`, [
      id,
      ...params,
    ]);
  const succeed = (scratch: ScratchDatabase, id: string) =>
    setRefund(
      scratch,
      id,
      `status = 'SUCCEEDED', "providerRefundId" = COALESCE("providerRefundId", 're_' || replace(id, '-', ''))`,
    );
  const refundRow = async (scratch: ScratchDatabase, id: string) =>
    (await run(scratch, `SELECT * FROM "PaymentRefund" WHERE id = $1`, [id]))
      .rows[0];
  const history = async (scratch: ScratchDatabase, id: string) =>
    (
      await run(
        scratch,
        `SELECT action, "fromStatus", "toStatus", "actorKind", "actorInternalUserId"
           FROM "PaymentRefundEvent" WHERE "refundId" = $1 ORDER BY "createdAt", id`,
        [id],
      )
    ).rows;
  it('is listed after every earlier migration', () => {
    expect(at).toBeGreaterThan(0);
  });

  describe('applied', () => {
    let scratch: ScratchDatabase;
    let completed: Paid;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp04_m5a_refunds',
      );
      await applyMigrations(scratch.url, before);
      await business(scratch, T1, 't1');
      await business(scratch, OTHER, 'other');
      // Existing built-in roles, as provisioning made them before M5a.
      for (const [tenantId, slug] of [
        [T1, 't1'],
        [OTHER, 'other'],
      ]) {
        await run(
          scratch,
          `INSERT INTO "InternalRole" (id, key, "displayName", "isSystem", "tenantId", "updatedAt")
           VALUES ($1, 'platform-administrator', 'Platform Administrator', true, $2, now()),
                  ($3, 'store-manager', 'Store Manager', true, $2, now())`,
          [`admin-role-${slug}`, tenantId, `manager-role-${slug}`],
        );
        await run(
          scratch,
          `INSERT INTO "InternalRolePermission" ("roleId", "permissionKey", "tenantId")
           VALUES ($1, 'orders.view', $3), ($2, 'orders.view', $3)`,
          [`admin-role-${slug}`, `manager-role-${slug}`, tenantId],
        );
      }
      await paidOrder(scratch);
      await applyMigrations(scratch.url, thisOne);
      completed = await paidOrder(scratch);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('grants orders.refund to every business owner role and creates the Refund Manager access level; nothing else changes', async () => {
      const { rows } = await run(
        scratch,
        `SELECT r."tenantId", r.key, r."isSystem",
                string_agg(p."permissionKey", ',' ORDER BY p."permissionKey") AS permissions
           FROM "InternalRole" r LEFT JOIN "InternalRolePermission" p ON p."roleId" = r.id
          GROUP BY r."tenantId", r.key, r."isSystem" ORDER BY r."tenantId", r.key`,
      );
      expect(rows).toEqual(
        [T1, OTHER].sort().flatMap((tenantId) => [
          {
            tenantId,
            key: 'platform-administrator',
            isSystem: true,
            permissions: 'orders.refund,orders.view',
          },
          {
            tenantId,
            key: 'refund-manager',
            isSystem: true,
            permissions: 'orders.refund,orders.view',
          },
          {
            tenantId,
            key: 'store-manager',
            isSystem: true,
            permissions: 'orders.view',
          },
        ]),
      );
      const refundRows = await run(
        scratch,
        `SELECT count(*)::int AS n FROM "PaymentRefund"`,
      );
      expect(refundRows.rows[0].n).toBe(0);
    });

    it('records a refund CENTERIVO asks for as REQUESTED, with its history written by the database', async () => {
      const id = await refund(scratch, completed, { amount: 250 });
      expect(await refundRow(scratch, id)).toMatchObject({
        status: 'REQUESTED',
        providerRefundId: null,
        succeededAt: null,
      });
      expect(await history(scratch, id)).toEqual([
        {
          action: 'CREATED',
          fromStatus: null,
          toStatus: 'REQUESTED',
          actorKind: 'STAFF',
          actorInternalUserId: 'manager-t1',
        },
      ]);
    });

    it('is only ever for a confirmed Stripe payment of that order, on its account, in its currency', async () => {
      const other = await paidOrder(scratch);
      await expect(
        refund(scratch, completed, { orderId: other.orderId }),
      ).rejects.toThrow(/order's own payment/);
      await expect(
        refund(scratch, completed, { account: OTHER_ACCT }),
      ).rejects.toThrow(/account the payment was made on/);
      await expect(
        refund(scratch, completed, { currency: 'EUR' }),
      ).rejects.toThrow(/own currency/);
      const fake = await paidOrder(scratch, { provider: 'fake' });
      await expect(refund(scratch, fake)).rejects.toThrow(
        /confirmed Stripe payment/,
      );
      const pending = await paidOrder(scratch, { status: 'PENDING' });
      await expect(refund(scratch, pending)).rejects.toThrow(
        /confirmed Stripe payment/,
      );
      const held = await paidOrder(scratch, { reconciliationRequired: true });
      await expect(refund(scratch, held)).rejects.toThrow(
        /needs reconciliation/,
      );
      // An order still in progress is cancelled, not refunded.
      for (const orderStatus of [
        'RECEIVED',
        'ACCEPTED',
        'PREPARING',
        'READY',
      ]) {
        const active = await paidOrder(scratch, { orderStatus });
        await expect(refund(scratch, active)).rejects.toThrow(
          /completed, rejected or cancelled/,
        );
      }
      // A CENTERIVO refund is recorded before Stripe is asked.
      await expect(
        refund(scratch, completed, {
          status: 'SUCCEEDED',
          providerRefundId: 're_Early1',
        }),
      ).rejects.toThrow(/recorded REQUESTED/);
      // A staff member is required; a refund made elsewhere names none and
      // carries Stripe's id.
      await expect(
        refund(scratch, completed, { requestedBy: null }),
      ).rejects.toThrow(/check constraint/);
      await expect(
        refund(scratch, completed, {
          origin: 'EXTERNAL',
          providerRefundId: null,
        }),
      ).rejects.toThrow(/check constraint/);
      await expect(
        refund(scratch, completed, { origin: 'EXTERNAL', status: 'UNKNOWN' }),
      ).rejects.toThrow(/as Stripe reports it|check constraint/);
      await expect(refund(scratch, completed, { amount: 0 })).rejects.toThrow(
        /check constraint/,
      );
    });

    it('belongs, with its order, payment and staff, to one business, and never moves', async () => {
      const elsewhere = await paidOrder(scratch, {
        tenantId: OTHER,
        slug: 'other',
      });
      // This business's refund of another business's payment / order / staff.
      await expect(
        refund(scratch, elsewhere, { tenantId: T1 }),
      ).rejects.toThrow(/needs its payment|foreign key/);
      await expect(
        refund(scratch, completed, { requestedBy: 'manager-other' }),
      ).rejects.toThrow(/foreign key/);
      const id = await refund(scratch, elsewhere);
      await expect(
        setRefund(scratch, id, `"tenantId" = $2`, [T1]),
      ).rejects.toThrow();
      expect(await refundRow(scratch, id)).toMatchObject({ tenantId: OTHER });
    });

    it('never takes the refunds of a payment over what was charged; only proven non-refunds give capacity back', async () => {
      const paid = await paidOrder(scratch, { amount: 1000 });
      const a = await refund(scratch, paid, { amount: 600 });
      const b = await refund(scratch, paid, { amount: 300 });
      await expect(refund(scratch, paid, { amount: 101 })).rejects.toThrow(
        /left to refund/,
      );
      // UNKNOWN keeps its reservation (the refund may exist).
      await setRefund(scratch, b, `status = 'UNKNOWN'`);
      await expect(refund(scratch, paid, { amount: 101 })).rejects.toThrow(
        /left to refund/,
      );
      // A refund made in the Dashboard counts too.
      await refund(scratch, paid, { origin: 'EXTERNAL', amount: 100 });
      await expect(refund(scratch, paid, { amount: 1 })).rejects.toThrow(
        /left to refund/,
      );
      // Proven not to have happened: its amount comes back.
      await setRefund(
        scratch,
        a,
        `status = 'FAILED', "providerRefundId" = 're_Failed600'`,
      );
      const c = await refund(scratch, paid, { amount: 600 });
      expect(c).toBeTruthy();
      await setRefund(
        scratch,
        c,
        `status = 'NOT_CREATED', "notCreatedEvidence" = 'NEVER_SENT'`,
      );
      await refund(scratch, paid, { amount: 600 });
    });

    it('serialises two concurrent requests: they can never both take the last of a payment', async () => {
      const paid = await paidOrder(scratch, { amount: 1000 });
      const first = new Client({ connectionString: scratch.url });
      const second = new Client({ connectionString: scratch.url });
      await first.connect();
      await second.connect();
      try {
        const insert = (c: Client, id: string) =>
          c.query(
            `INSERT INTO "PaymentRefund" (id, "tenantId", "orderId", "paymentAttemptId", provider, "providerAccountId",
               origin, "amountMinorUnits", currency, "reasonCode", "requestedByInternalUserId", "idempotencyKey",
               status, "updatedAt")
             VALUES ($1, $2, $3, $4, 'stripe', $5, 'CENTERIVO', 600, 'USD', 'CUSTOMER_REQUEST', 'manager-t1',
               'centerivo-refund:' || $1, 'REQUESTED', now())`,
            [id, T1, paid.orderId, paid.attemptId, ACCT],
          );
        await first.query('BEGIN');
        await second.query('BEGIN');
        await insert(first, next('rf-concurrent'));
        // The second waits for the first's lock on the payment...
        const racing = insert(second, next('rf-concurrent')).then(
          () => 'inserted',
          (error: Error) => error.message,
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        await first.query('COMMIT');
        // ...then counts the first's 600, and is refused.
        expect(await racing).toMatch(/left to refund/);
        await second.query('ROLLBACK');
      } finally {
        await first.end();
        await second.end();
      }
      const { rows } = await run(
        scratch,
        `SELECT count(*)::int AS n FROM "PaymentRefund" WHERE "paymentAttemptId" = $1`,
        [paid.attemptId],
      );
      expect(rows[0].n).toBe(1);
    });

    it.each(['REPEATABLE READ', 'SERIALIZABLE'])(
      'refuses %s, where the capacity count could come from a stale snapshot',
      async (level) => {
        const paid = await paidOrder(scratch);
        await expect(
          inTransaction(scratch, [
            [`SET TRANSACTION ISOLATION LEVEL ${level}`],
            [
              `INSERT INTO "PaymentRefund" (id, "tenantId", "orderId", "paymentAttemptId", provider, "providerAccountId",
                 origin, "amountMinorUnits", currency, "reasonCode", "requestedByInternalUserId", "idempotencyKey",
                 status, "updatedAt")
               VALUES ('rf-iso', $1, $2, $3, 'stripe', $4, 'CENTERIVO', 100, 'USD', 'CUSTOMER_REQUEST', 'manager-t1',
                 'centerivo-refund:rf-iso', 'REQUESTED', now())`,
              [T1, paid.orderId, paid.attemptId, ACCT],
            ],
          ]),
        ).rejects.toThrow(/only at READ COMMITTED/);
      },
    );

    it('keys each operation by its own id, stamps times in UTC whatever the session time zone, and rejects forged history', async () => {
      const paid = await paidOrder(scratch);
      // Another key than the operation's own: refused.
      await expect(
        run(
          scratch,
          `INSERT INTO "PaymentRefund" (id, "tenantId", "orderId", "paymentAttemptId", provider, "providerAccountId",
             origin, "amountMinorUnits", currency, "reasonCode", "requestedByInternalUserId", "idempotencyKey",
             status, "updatedAt")
           VALUES ('rf-key', $1, $2, $3, 'stripe', $4, 'CENTERIVO', 100, 'USD', 'CUSTOMER_REQUEST', 'manager-t1',
             'some-other-key', 'REQUESTED', now())`,
          [T1, paid.orderId, paid.attemptId, ACCT],
        ),
      ).rejects.toThrow(/check constraint/);
      // A session twelve hours behind UTC cannot backdate a success.
      const id = await refund(scratch, paid, { amount: 100 });
      await inTransaction(scratch, [
        [`SET LOCAL TIME ZONE 'Etc/GMT+12'`],
        [
          `UPDATE "PaymentRefund" SET status = 'SUCCEEDED', "providerRefundId" = 're_Utc1' WHERE id = $1`,
          [id],
        ],
      ]);
      const { rows } = await run(
        scratch,
        `SELECT abs(extract(epoch FROM ("succeededAt" - (now() AT TIME ZONE 'UTC'))))::int AS skew
           FROM "PaymentRefund" WHERE id = $1`,
        [id],
      );
      expect(rows[0].skew).toBeLessThan(60);
      // Entries the database writes cannot be inserted by the application.
      for (const action of [
        'CREATED',
        'STATUS_CHANGED',
        'LATE_FAILURE_REVIEWED',
        'PROVIDER_REFUND_ID_RECORDED',
      ]) {
        await expect(
          run(
            scratch,
            `INSERT INTO "PaymentRefundEvent" (id, "tenantId", "refundId", action, "actorKind")
             VALUES ($1, $2, $3, $4, 'SYSTEM')`,
            [`ev-forged-${action}`, T1, id, action],
          ),
        ).rejects.toThrow(/written only by the database/);
      }
      await expect(
        run(
          scratch,
          `INSERT INTO "PaymentRefundEvent" (id, "tenantId", "refundId", action, "toStatus", "actorKind")
           VALUES ('ev-forged-status', $1, $2, 'NOTE', 'SUCCEEDED', 'SYSTEM')`,
          [T1, id],
        ),
      ).rejects.toThrow(/written only by the database/);
    });

    it('"never created" needs its evidence: never from a timeout or time alone, and the evidence is kept', async () => {
      const paid = await paidOrder(scratch);
      const notCreated = (id: string, evidence: string | null) =>
        setRefund(
          scratch,
          id,
          `status = 'NOT_CREATED', "notCreatedEvidence" = $2`,
          [evidence],
        );
      // Never sent: provably not created, with that evidence recorded.
      const unsent = await refund(scratch, paid, { amount: 100 });
      await expect(notCreated(unsent, null)).rejects.toThrow(
        /only with its evidence/,
      );
      await expect(notCreated(unsent, 'A_GUESS')).rejects.toThrow(
        /only with its evidence/,
      );
      await expect(
        notCreated(unsent, 'STRIPE_HISTORY_VERIFIED'),
      ).rejects.toThrow(/never sent has no Stripe history/);
      await notCreated(unsent, 'NEVER_SENT');
      expect(await refundRow(scratch, unsent)).toMatchObject({
        status: 'NOT_CREATED',
        notCreatedEvidence: 'NEVER_SENT',
      });
      expect(
        (await refundRow(scratch, unsent)).notCreatedRecordedAt,
      ).not.toBeNull();
      const created = (await history(scratch, unsent)).at(-1);
      expect(created).toMatchObject({ toStatus: 'NOT_CREATED' });
      const { rows: detail } = await run(
        scratch,
        `SELECT detail FROM "PaymentRefundEvent" WHERE "refundId" = $1 AND "toStatus" = 'NOT_CREATED'`,
        [unsent],
      );
      expect(detail[0].detail).toEqual({ notCreatedEvidence: 'NEVER_SENT' });
      // The evidence never changes afterwards.
      await expect(
        setRefund(
          scratch,
          unsent,
          `"notCreatedEvidence" = 'STRIPE_HISTORY_VERIFIED'`,
        ),
      ).rejects.toThrow(/set only by its status/);
      // Sent, then the answer was lost: unknown. Neither "never sent", nor —
      // inside the idempotency window — verifiable from Stripe's history.
      const sent = await refund(scratch, paid, { amount: 100 });
      await setRefund(
        scratch,
        sent,
        `"firstSentAt" = now(), status = 'UNKNOWN'`,
      );
      await expect(notCreated(sent, null)).rejects.toThrow(
        /only with its evidence/,
      );
      await expect(notCreated(sent, 'NEVER_SENT')).rejects.toThrow(
        /not "never sent"/,
      );
      await expect(notCreated(sent, 'STRIPE_HISTORY_VERIFIED')).rejects.toThrow(
        /less than 24 hours ago/,
      );
      // Time alone is not proof: past the window it still needs the
      // verified Stripe history.
      await inTransaction(scratch, [
        ['SET LOCAL session_replication_role = replica'],
        [
          `UPDATE "PaymentRefund" SET "firstSentAt" = now() - interval '25 hours' WHERE id = $1`,
          [sent],
        ],
      ]);
      await expect(notCreated(sent, null)).rejects.toThrow(
        /only with its evidence/,
      );
      expect(await refundRow(scratch, sent)).toMatchObject({
        status: 'UNKNOWN',
      });
      await notCreated(sent, 'STRIPE_HISTORY_VERIFIED');
      // Evidence on any other status is refused.
      const other = await refund(scratch, paid, { amount: 100 });
      await expect(
        setRefund(scratch, other, `"notCreatedEvidence" = 'NEVER_SENT'`),
      ).rejects.toThrow(/set only by its status|check constraint/);
    });

    it('a refund made outside CENTERIVO is recorded only as Stripe reports it, never already returned or reviewed', async () => {
      const paid = await paidOrder(scratch);
      await expect(
        refund(scratch, paid, {
          origin: 'EXTERNAL',
          status: 'FAILED_AFTER_SUCCESS',
        }),
      ).rejects.toThrow(/as Stripe reports it|check constraint/);
      const failed = await refund(scratch, paid, {
        origin: 'EXTERNAL',
        status: 'FAILED',
      });
      expect(await refundRow(scratch, failed)).toMatchObject({
        status: 'FAILED',
        succeededAt: null,
      });
    });

    it('moves status only forward, stamping success and late-failure times from the database clock', async () => {
      const paid = await paidOrder(scratch);
      const id = await refund(scratch, paid, { amount: 400 });
      // An application-supplied time is ignored.
      await setRefund(
        scratch,
        id,
        `status = 'PENDING', "providerRefundId" = 're_Moves1', "firstSentAt" = now()`,
      );
      await setRefund(
        scratch,
        id,
        `status = 'SUCCEEDED', "succeededAt" = '2000-01-01'`,
      );
      const succeeded = await refundRow(scratch, id);
      expect((succeeded.succeededAt as Date).getFullYear()).toBeGreaterThan(
        2000,
      );
      for (const to of [
        'REQUESTED',
        'PENDING',
        'UNKNOWN',
        'FAILED',
        'CANCELED',
        'NOT_CREATED',
      ]) {
        await expect(
          setRefund(scratch, id, `status = $2`, [to]),
        ).rejects.toThrow(/cannot move/);
      }
      await setRefund(
        scratch,
        id,
        `status = 'FAILED_AFTER_SUCCESS', "providerFailureReason" = 'expired_or_canceled_card'`,
      );
      const late = await refundRow(scratch, id);
      expect(late.succeededAt).toEqual(succeeded.succeededAt);
      expect(late.failedAfterSuccessAt).not.toBeNull();
      await expect(
        setRefund(scratch, id, `status = 'SUCCEEDED'`),
      ).rejects.toThrow(/cannot move/);
      expect(
        (await history(scratch, id)).map(
          (e) => `${String(e.action)}:${String(e.toStatus)}`,
        ),
      ).toEqual([
        'CREATED:REQUESTED',
        'STATUS_CHANGED:PENDING',
        'STATUS_CHANGED:SUCCEEDED',
        'STATUS_CHANGED:FAILED_AFTER_SUCCESS',
      ]);
      // "Never created" cannot be claimed for a refund Stripe gave an id to.
      // (Another payment: the late failure above blocks this one until it is
      // reviewed.)
      await expect(refund(scratch, paid, { amount: 100 })).rejects.toThrow(
        /must be reviewed/,
      );
      const another = await paidOrder(scratch);
      const named = await refund(scratch, another, { amount: 100 });
      await setRefund(
        scratch,
        named,
        `status = 'UNKNOWN', "providerRefundId" = 're_Named1'`,
      );
      await expect(
        setRefund(scratch, named, `status = 'NOT_CREATED'`),
      ).rejects.toThrow(/gave an id to|check constraint/);
      // A status Stripe reported carries its id.
      const bare = await refund(scratch, another, { amount: 100 });
      await expect(
        setRefund(scratch, bare, `status = 'SUCCEEDED'`),
      ).rejects.toThrow(/check constraint/);
    });

    it('protects identity, the Stripe id, the first sending, and never deletes a refund or its history', async () => {
      const paid = await paidOrder(scratch);
      const id = await refund(scratch, paid, { amount: 100 });
      for (const [sets, params] of [
        [`"amountMinorUnits" = 99`, []],
        [`currency = 'EUR'`, []],
        [`"reasonCode" = 'OTHER'`, []],
        [`note = 'changed'`, []],
        [`"requestedByInternalUserId" = 'owner-t1'`, []],
        [`"idempotencyKey" = 'another-key'`, []],
        [`origin = 'EXTERNAL'`, []],
        [`"createdAt" = now() - interval '1 day'`, []],
      ] as Array<[string, unknown[]]>) {
        await expect(setRefund(scratch, id, sets, params)).rejects.toThrow(
          /identity never changes/,
        );
      }
      await setRefund(scratch, id, `"firstSentAt" = now(), status = 'UNKNOWN'`);
      await expect(
        setRefund(scratch, id, `"firstSentAt" = now() - interval '1 hour'`),
      ).rejects.toThrow(/first sent/);
      await setRefund(
        scratch,
        id,
        `"providerRefundId" = 're_Once1', status = 'PENDING'`,
      );
      await expect(
        setRefund(scratch, id, `"providerRefundId" = 're_Twice1'`),
      ).rejects.toThrow(/cannot change once recorded/);
      // One Stripe refund is recorded once, anywhere (even another business).
      const elsewhere = await paidOrder(scratch, {
        tenantId: OTHER,
        slug: 'other',
      });
      await expect(
        refund(scratch, elsewhere, {
          origin: 'EXTERNAL',
          providerRefundId: 're_Once1',
        }),
      ).rejects.toThrow(/unique/);
      await expect(
        run(scratch, `DELETE FROM "PaymentRefund" WHERE id = $1`, [id]),
      ).rejects.toThrow(/never deleted/);
      await expect(
        run(scratch, `TRUNCATE "PaymentRefund" CASCADE`),
      ).rejects.toThrow(/append-only/);
      await expect(
        run(
          scratch,
          `UPDATE "PaymentRefundEvent" SET action = 'EDITED' WHERE "refundId" = $1`,
          [id],
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        run(scratch, `DELETE FROM "PaymentRefundEvent" WHERE "refundId" = $1`, [
          id,
        ]),
      ).rejects.toThrow(/append-only/);
      await expect(
        run(scratch, `TRUNCATE "PaymentRefundEvent"`),
      ).rejects.toThrow(/append-only/);
      // An attributed entry names exactly one kind of actor.
      await expect(
        run(
          scratch,
          `INSERT INTO "PaymentRefundEvent" (id, "tenantId", "refundId", action, "actorKind")
           VALUES ('ev-bad', $1, $2, 'NOTE', 'STAFF')`,
          [T1, id],
        ),
      ).rejects.toThrow(/check constraint/);
      await run(
        scratch,
        `INSERT INTO "PaymentRefundEvent" (id, "tenantId", "refundId", action, "actorKind", "actorPlatformOperatorId")
         VALUES ('ev-platform', $1, $2, 'SUPPORT_RECHECKED', 'PLATFORM', 'operator-1')`,
        [T1, id],
      );
    });

    it('a refund whose money came back blocks new refunds of the payment until a staff member reviews it, once', async () => {
      const paid = await paidOrder(scratch, { amount: 1000 });
      const id = await refund(scratch, paid, { amount: 1000 });
      await succeed(scratch, id);
      await expect(
        setRefund(
          scratch,
          id,
          `"lateFailureReviewedAt" = now(), "lateFailureReviewedByInternalUserId" = 'owner-t1', "lateFailureReviewNote" = 'Checked'`,
        ),
      ).rejects.toThrow(/check constraint/);
      await setRefund(scratch, id, `status = 'FAILED_AFTER_SUCCESS'`);
      // Its amount is free again, but no new refund until it is reviewed.
      await expect(refund(scratch, paid, { amount: 1000 })).rejects.toThrow(
        /must be reviewed/,
      );
      await setRefund(
        scratch,
        id,
        `"lateFailureReviewedAt" = '2000-01-01', "lateFailureReviewedByInternalUserId" = 'owner-t1', "lateFailureReviewNote" = 'Card expired; customer gave a new card at the counter.'`,
      );
      const reviewed = await refundRow(scratch, id);
      expect(
        (reviewed.lateFailureReviewedAt as Date).getFullYear(),
      ).toBeGreaterThan(2000);
      await expect(
        setRefund(scratch, id, `"lateFailureReviewNote" = 'Rewritten'`),
      ).rejects.toThrow(/reviewed only once/);
      expect((await history(scratch, id)).at(-1)).toEqual({
        action: 'LATE_FAILURE_REVIEWED',
        fromStatus: 'FAILED_AFTER_SUCCESS',
        toStatus: 'FAILED_AFTER_SUCCESS',
        actorKind: 'STAFF',
        actorInternalUserId: 'owner-t1',
      });
      // Reviewed: a replacement refund may be made, for what is owed.
      await refund(scratch, paid, { amount: 1000 });
    });

    it('an obligation partly covered by a Dashboard refund is never settled; only the rest may be refunded', async () => {
      const paid = await paidOrder(scratch, {
        amount: 1000,
        orderStatus: 'ACCEPTED',
      });
      const obligation = await cancelWithObligation(scratch, paid);
      const external = await refund(scratch, paid, {
        origin: 'EXTERNAL',
        amount: 300,
      });
      const externalId = (await refundRow(scratch, external))
        .providerRefundId as string;
      const settle = (refundId: string) =>
        run(
          scratch,
          `UPDATE "OrderRefundObligation"
              SET status = 'REFUNDED', "settlementMethod" = 'PROCESSOR', "processorRefundId" = $2, "settledAt" = now()
            WHERE id = $1`,
          [obligation, refundId],
        );
      await expect(settle(externalId)).rejects.toThrow(/only partly refunded/);
      // Never the whole obligation again: only what is left.
      await expect(refund(scratch, paid, { amount: 1000 })).rejects.toThrow(
        /left to refund/,
      );
      const rest = await refund(scratch, paid, { amount: 700 });
      await run(
        scratch,
        `UPDATE "OrderRefundObligation" SET status = 'PROCESSING' WHERE id = $1`,
        [obligation],
      );
      // In flight: not settled.
      await expect(settle(externalId)).rejects.toThrow(/still in progress/);
      await succeed(scratch, rest);
      const restId = (await refundRow(scratch, rest))
        .providerRefundId as string;
      // A refund id that is not a succeeded refund of this payment.
      await expect(settle('re_NotOurs1')).rejects.toThrow(
        /succeeded refund of its own payment/,
      );
      // Fully refunded and verified: settled at once (no waiting period).
      await settle(restId);
      const { rows } = await run(
        scratch,
        `SELECT status, "settlementMethod", "processorRefundId" FROM "OrderRefundObligation" WHERE id = $1`,
        [obligation],
      );
      expect(rows[0]).toEqual({
        status: 'REFUNDED',
        settlementMethod: 'PROCESSOR',
        processorRefundId: restId,
      });
    });

    it('a returned refund blocks settlement until reviewed; one returned after settlement is flagged and owed again', async () => {
      const paid = await paidOrder(scratch, {
        amount: 1000,
        orderStatus: 'ACCEPTED',
      });
      const obligation = await cancelWithObligation(scratch, paid);
      const settle = (refundId: string) =>
        run(
          scratch,
          `UPDATE "OrderRefundObligation"
              SET status = 'REFUNDED', "settlementMethod" = 'PROCESSOR', "processorRefundId" = $2, "settledAt" = now()
            WHERE id = $1`,
          [obligation, refundId],
        );
      // The first refund succeeds, then its money comes back.
      const first = await refund(scratch, paid, { amount: 1000 });
      await succeed(scratch, first);
      await setRefund(scratch, first, `status = 'FAILED_AFTER_SUCCESS'`);
      // The restaurant refunds again from its Dashboard.
      const replacement = await refund(scratch, paid, {
        origin: 'EXTERNAL',
        amount: 1000,
      });
      const replacementId = (await refundRow(scratch, replacement))
        .providerRefundId as string;
      await run(
        scratch,
        `UPDATE "OrderRefundObligation" SET status = 'PROCESSING' WHERE id = $1`,
        [obligation],
      );
      await expect(settle(replacementId)).rejects.toThrow(/unreviewed/);
      await setRefund(
        scratch,
        first,
        `"lateFailureReviewedAt" = now(), "lateFailureReviewedByInternalUserId" = 'owner-t1', "lateFailureReviewNote" = 'Reviewed'`,
      );
      await settle(replacementId);
      // Even after settlement a refund can come back: it is recorded, flagged
      // in its history, and its amount is owed again (capacity returns).
      await setRefund(scratch, replacement, `status = 'FAILED_AFTER_SUCCESS'`);
      const { rows } = await run(
        scratch,
        `SELECT detail FROM "PaymentRefundEvent"
          WHERE "refundId" = $1 AND "toStatus" = 'FAILED_AFTER_SUCCESS'`,
        [replacement],
      );
      expect(rows[0].detail).toEqual({ obligationAlreadySettled: true });
      // The settled obligation keeps its history (S5a: REFUNDED never
      // changes); no replacement refund until a staff member reviews it.
      const { rows: obligationRows } = await run(
        scratch,
        `SELECT status FROM "OrderRefundObligation" WHERE id = $1`,
        [obligation],
      );
      expect(obligationRows[0].status).toBe('REFUNDED');
      await expect(refund(scratch, paid, { amount: 1000 })).rejects.toThrow(
        /must be reviewed/,
      );
      await setRefund(
        scratch,
        replacement,
        `"lateFailureReviewedAt" = now(), "lateFailureReviewedByInternalUserId" = 'owner-t1', "lateFailureReviewNote" = 'Customer contacted'`,
      );
      // Reviewed: what is owed again (all of it) may be refunded.
      await refund(scratch, paid, { amount: 1000 });
    });

    it("a Stripe payment's obligation is never settled by hand (S5c); another provider's still can be", async () => {
      const paid = await paidOrder(scratch, { orderStatus: 'ACCEPTED' });
      const obligation = await cancelWithObligation(scratch, paid);
      const manual = (id: string) =>
        run(
          scratch,
          `UPDATE "OrderRefundObligation"
              SET status = 'REFUNDED', "settlementMethod" = 'MANUAL_EXTERNAL', "settlementReference" = 'Terminal 42',
                  "settledAt" = now(), "settledByInternalUserId" = 'owner-t1'
            WHERE id = $1`,
          [id],
        );
      await expect(manual(obligation)).rejects.toThrow(
        /never settled manually/,
      );
      const simulated = await paidOrder(scratch, {
        provider: 'fake',
        orderStatus: 'ACCEPTED',
      });
      const simulatedObligation = await cancelWithObligation(
        scratch,
        simulated,
      );
      await manual(simulatedObligation);
    });

    it('an order is not closed while a refund of its payment is in flight; an answered one counts towards its obligation', async () => {
      const paid = await paidOrder(scratch, {
        amount: 1000,
        orderStatus: 'ACCEPTED',
      });
      // A refund made in the Dashboard on an order still in progress.
      const pending = await refund(scratch, paid, {
        origin: 'EXTERNAL',
        amount: 200,
        status: 'PENDING',
      });
      await expect(cancelWithObligation(scratch, paid)).rejects.toThrow(
        /still in progress/,
      );
      await succeed(scratch, pending);
      const obligation = await cancelWithObligation(scratch, paid);
      expect(obligation).toBeTruthy();
      // What is still owed: 1000 − 200.
      await expect(refund(scratch, paid, { amount: 801 })).rejects.toThrow(
        /left to refund/,
      );
      await refund(scratch, paid, { amount: 800 });
    });

    it('recorded refunds can never exceed the charge, even from outside CENTERIVO', async () => {
      const paid = await paidOrder(scratch, { amount: 500 });
      await refund(scratch, paid, { origin: 'EXTERNAL', amount: 400 });
      await expect(
        refund(scratch, paid, { origin: 'EXTERNAL', amount: 101 }),
      ).rejects.toThrow(/exceed what was charged/);
      // A refund made elsewhere is recorded even while a CENTERIVO request is
      // unanswered (that request then cannot have happened at Stripe).
      const paid2 = await paidOrder(scratch, { amount: 500 });
      const asked = await refund(scratch, paid2, { amount: 500 });
      await refund(scratch, paid2, { origin: 'EXTERNAL', amount: 500 });
      await expect(succeed(scratch, asked)).rejects.toThrow(
        /exceed what was charged/,
      );
    });
  });

  describe('rollback and preflight', () => {
    it('the rollback refuses while any refund exists, and otherwise removes everything it added', async () => {
      const scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp04_m5a_rollback',
      );
      try {
        await applyMigrations(scratch.url, before);
        await business(scratch, T1, 't1');
        await run(
          scratch,
          `INSERT INTO "InternalRole" (id, key, "displayName", "isSystem", "tenantId", "updatedAt")
           VALUES ('admin-role-t1', 'platform-administrator', 'Platform Administrator', true, $1, now())`,
          [T1],
        );
        await applyMigrations(scratch.url, thisOne);
        const paid = await paidOrder(scratch);
        await refund(scratch, paid);
        await expect(
          applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
        ).rejects.toThrow(/rollback refused: 2 payment refund record/);
        expect(
          (
            await run(
              scratch,
              `SELECT to_regclass('"PaymentRefund"') IS NOT NULL AS present`,
            )
          ).rows[0].present,
        ).toBe(true);
      } finally {
        await scratch.drop();
      }
    });

    it('rolls back cleanly with nothing to keep, and refuses while someone holds the Refund Manager access level', async () => {
      const scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp04_m5a_rollback_clean',
      );
      try {
        await applyMigrations(scratch.url, before);
        await business(scratch, T1, 't1');
        await run(
          scratch,
          `INSERT INTO "InternalRole" (id, key, "displayName", "isSystem", "tenantId", "updatedAt")
           VALUES ('admin-role-t1', 'platform-administrator', 'Platform Administrator', true, $1, now())`,
          [T1],
        );
        await applyMigrations(scratch.url, thisOne);
        const role = (
          await run(
            scratch,
            `SELECT id FROM "InternalRole" WHERE key = 'refund-manager' AND "tenantId" = $1`,
            [T1],
          )
        ).rows[0].id as string;
        await run(
          scratch,
          `INSERT INTO "InternalUserRoleAssignment" (id, "tenantId", "internalUserId", "roleId", "scopeType", "scopeId", "updatedAt")
           VALUES ('assign-1', $1, 'manager-t1', $2, 'LOCATION', 'loc-t1', now())`,
          [T1, role],
        );
        await expect(
          applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
        ).rejects.toThrow(/Refund Manager" assignment/);
        await run(
          scratch,
          `DELETE FROM "InternalUserRoleAssignment" WHERE id = 'assign-1'`,
        );
        await applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8'));
        const { rows } = await run(
          scratch,
          `SELECT to_regclass('"PaymentRefund"') IS NULL AS refunds_gone,
                  to_regclass('"PaymentRefundEvent"') IS NULL AS events_gone,
                  to_regprocedure('payment_refund_guard()') IS NULL AS guard_gone,
                  to_regprocedure('order_refund_obligation_refund_evidence()') IS NULL AS evidence_gone,
                  to_regprocedure('order_closure_refund_in_flight()') IS NULL AS closure_guard_gone,
                  (SELECT count(*)::int FROM "InternalRole" WHERE key = 'refund-manager') AS roles,
                  (SELECT count(*)::int FROM "InternalRolePermission" WHERE "permissionKey" = 'orders.refund') AS grants`,
        );
        expect(rows[0]).toEqual({
          refunds_gone: true,
          events_gone: true,
          guard_gone: true,
          evidence_gone: true,
          closure_guard_gone: true,
          roles: 0,
          grants: 0,
        });
      } finally {
        await scratch.drop();
      }
    });

    it('the preflight refuses, changing nothing, when a Refund Manager role already exists', async () => {
      const scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp04_m5a_preflight',
      );
      try {
        await applyMigrations(scratch.url, before);
        await business(scratch, T1, 't1');
        await run(
          scratch,
          `INSERT INTO "InternalRole" (id, key, "displayName", "isSystem", "tenantId", "updatedAt")
           VALUES ('custom', 'refund-manager', 'Someone else''s role', false, $1, now())`,
          [T1],
        );
        await expect(
          applyMigrationSql(
            scratch.url,
            readFileSync(
              join(MIGRATIONS, THIS_MIGRATION, 'migration.sql'),
              'utf8',
            ),
          ),
        ).rejects.toThrow(/"refund-manager" role already exists/);
        const { rows } = await run(
          scratch,
          `SELECT to_regclass('"PaymentRefund"') IS NULL AS absent`,
        );
        expect(rows[0].absent).toBe(true);
      } finally {
        await scratch.drop();
      }
    });
  });
});
