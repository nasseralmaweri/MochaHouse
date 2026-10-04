import 'dotenv/config';
import { join } from 'node:path';
import { MODEL_TENANCY, TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  TENANT_ID_REQUIRED_MODELS,
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  isAppliedAtomically,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';

// Milestone S0D-2C-1 — the guarded, parent-derived backfill + NOT NULL
// migration for PaymentAttempt, Order, OrderLine and OrderStatusHistory
// ONLY, exercised on throwaway scratch databases starting from the exact
// post-S0D-2B-2 state, with rows written in the nullable window that
// exercise every PaymentAttempt backfill tier.

jest.setTimeout(180_000);

const repoRoot = join(__dirname, '../../../..');
const migrations = listMigrations(
  join(repoRoot, 'packages/database/prisma/migrations'),
);
const targetIndex = migrations.findIndex((m) =>
  m.name.endsWith('_require_tenant_id_order_payment'),
);
const before = migrations.slice(0, targetIndex);
const target = migrations[targetIndex];

const CONVERTED = [
  'Order',
  'OrderLine',
  'OrderStatusHistory',
  'PaymentAttempt',
];
// Models already NOT NULL before this migration (S0D-2A, S0D-2B-1,
// S0D-2B-2) plus the four converted here.
const REQUIRED_AFTER = new Set([
  'Location',
  'Category',
  'Product',
  'Menu',
  'ModifierGroup',
  'ModifierOption',
  'ProductModifierGroup',
  'MenuProduct',
  'LocationMenu',
  'LocationProductPriceOverride',
  'LocationProductAvailabilityOverride',
  'ChecklistTemplate',
  'ChecklistTemplateItem',
  'ChecklistInstance',
  'ChecklistInstanceItem',
  'OperationsTask',
  'Customer',
  'CustomerPreferredLocation',
  'CustomerNote',
  ...CONVERTED,
]);
const tenantTables = Object.entries(MODEL_TENANCY)
  .filter(([, tenancy]) => tenancy === 'tenant')
  .map(([model]) => model)
  // Milestone S0D-2C-3 added NotificationRecipient AFTER this migration;
  // this test is pinned to the schema exactly as it existed at `target`,
  // which never has that table.
  .filter((model) => model !== 'NotificationRecipient');

const baseUrl = process.env.DATABASE_URL!;
const T1 = TENANT_1_MOCHA_HOUSE_ID;

// Window rows — one PaymentAttempt per backfill tier:
//   pa-order  -> tier 1 (its Order)
//   pa-loc    -> tier 2 (the Location named by its locationId; no Order)
//   pa-gc     -> tier 3 (its GiftCardPurchase carries a tenant)
//   pa-gc-c   -> tier 4 (its tenantless GiftCardPurchase's Customer)
//   pa-orphan -> tier 5 (nothing attributable; single-tenant guard)
const WINDOW_ROWS_SQL = `
INSERT INTO "Location" (id, name, slug, "updatedAt", "tenantId")
  VALUES ('loc-w', 'Window', 'window', now(), '${T1}');
INSERT INTO "Customer" (id, "externalProvider", "externalSubject", "updatedAt", "tenantId")
  VALUES ('cust-w', 'dev', 'dev:window', now(), '${T1}');
INSERT INTO "PaymentAttempt" (id, "idempotencyKey", provider, status, "locationId", amount, currency, "updatedAt") VALUES
  ('pa-order',  'k-order',  'fake', 'SUCCEEDED', 'loc-w', 400, 'USD', now()),
  ('pa-loc',    'k-loc',    'fake', 'DECLINED',  'loc-w', 400, 'USD', now()),
  ('pa-gc',     'k-gc',     'fake', 'PENDING',   NULL,    2500, 'USD', now()),
  ('pa-gc-c',   'k-gc-c',   'fake', 'PENDING',   NULL,    2500, 'USD', now()),
  ('pa-orphan', 'k-orphan', 'fake', 'PENDING',   NULL,    2500, 'USD', now());
INSERT INTO "GiftCardPurchase" (id, "paymentAttemptId", "amountMinorUnits", "purchaserEmail", "updatedAt", "tenantId", "customerId") VALUES
  ('gcp-t', 'pa-gc',   2500, 'a@example.com', now(), '${T1}', NULL),
  ('gcp-c', 'pa-gc-c', 2500, 'b@example.com', now(), NULL, 'cust-w');
INSERT INTO "Order" (id, "orderNumber", "accessToken", "locationId", "customerId", "paymentAttemptId",
                     "guestName", "guestPhone", currency, subtotal, "updatedAt")
  VALUES ('ord-w', 'W-1', 'tok-w', 'loc-w', 'cust-w', 'pa-order', 'G', '555', 'USD', 400, now());
INSERT INTO "OrderLine" (id, "orderId", "productId", "productName", "unitPrice", quantity, "lineTotal", currency, selections)
  VALUES ('ol-w', 'ord-w', 'p', 'P', 400, 1, 400, 'USD', '[]');
INSERT INTO "OrderStatusHistory" (id, "orderId", status) VALUES ('osh-w', 'ord-w', 'RECEIVED');
INSERT INTO "OutboxEvent" (id, "aggregateType", "aggregateId", "eventType", payload)
  VALUES ('ev-w', 'Order', 'ord-w', 'order.checkout.completed', '{}');
`;

async function query<T extends object>(
  url: string,
  sql: string,
  params: unknown[] = [],
) {
  return withScratchClient(url, async (client) => {
    const { rows } = await client.query<T>(sql, params);
    return rows;
  });
}

async function nullability(url: string): Promise<Record<string, string>> {
  const rows = await query<{ table_name: string; is_nullable: string }>(
    url,
    `SELECT table_name, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'tenantId'`,
  );
  return Object.fromEntries(rows.map((r) => [r.table_name, r.is_nullable]));
}

async function tenantIds(url: string, table: string) {
  const rows = await query<{ id: string; tenantId: string | null }>(
    url,
    `SELECT id, "tenantId" FROM "${table}" ORDER BY id`,
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.tenantId]));
}

async function allConvertedStillNull(url: string) {
  const columns = await nullability(url);
  for (const table of CONVERTED) {
    expect({ table, nullable: columns[table] }).toEqual({
      table,
      nullable: 'YES',
    });
    const ids = await tenantIds(url, table);
    for (const [id, tenantId] of Object.entries(ids)) {
      expect({ table, id, tenantId }).toEqual({ table, id, tenantId: null });
    }
  }
}

// Everything the migration must NOT change: constraints, indexes, triggers
// (including the paymentAttemptId single-payment-domain triggers) and
// column defaults across the schema, plus the enum catalogue.
async function structure(url: string) {
  const pick = async (sql: string) =>
    (await query<{ def: string }>(url, sql)).map((r) => r.def);
  return {
    constraints: await pick(
      `SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1`,
    ),
    indexes: await pick(
      `SELECT indexdef AS def FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
    ),
    triggers: await pick(
      `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`,
    ),
    defaults: await pick(
      `SELECT table_name || '.' || column_name || '=' || column_default AS def
         FROM information_schema.columns
        WHERE table_schema = 'public' AND column_default IS NOT NULL ORDER BY 1`,
    ),
    enums: await pick(
      `SELECT t.typname || '.' || e.enumlabel AS def
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid ORDER BY 1`,
    ),
  };
}

// Plants a row state the application and the FKs would never allow, by
// skipping FK enforcement for ONE statement batch on the scratch database
// only. Used to prove each post-backfill consistency check fires.
async function withoutFkChecks(url: string, sql: string) {
  await applyMigrationSql(
    url,
    `SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`,
  );
}

async function expectAbort(url: string, message: RegExp) {
  await expect(applyMigrationSql(url, target.sql)).rejects.toThrow(message);
}

describe('S0D-2C-1 order & payment NOT NULL migration (scratch databases)', () => {
  let scratch: ScratchDatabase;
  let structureBefore: Awaited<ReturnType<typeof structure>>;

  beforeAll(async () => {
    scratch = await createScratchDatabase(baseUrl, 's0d2c1');
    await applyMigrations(scratch.url, before);
    await applyMigrationSql(scratch.url, WINDOW_ROWS_SQL);
    structureBefore = await structure(scratch.url);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('follows S0D-2B-2, is atomic, alters ONLY the four models, and orders guards → backfill → checks → NOT NULL', () => {
    expect(targetIndex).toBeGreaterThan(0);
    expect(before[before.length - 1].name).toMatch(
      /_require_tenant_id_customer_children$/,
    );
    expect(isAppliedAtomically(target.sql)).toBe(true);

    const altered = [
      ...target.sql.matchAll(
        /ALTER TABLE "(\w+)" ALTER COLUMN "tenantId" SET NOT NULL;/g,
      ),
    ].map((m) => m[1]);
    expect(altered.sort()).toEqual([...CONVERTED].sort());
    expect(target.sql).not.toMatch(
      /ADD VALUE|CREATE TYPE|DEFAULT|UNIQUE|FOREIGN KEY|CREATE TRIGGER|DROP TRIGGER|CREATE INDEX|DROP /,
    );
    // OutboxEvent / NotificationDelivery are NOT converted here.
    expect(target.sql).not.toMatch(/"OutboxEvent"|"NotificationDelivery"/);

    const at = (needle: string) => target.sql.indexOf(needle);
    const firstUpdate = at('UPDATE "Order"');
    expect(at('not ACTIVE')).toBeLessThan(firstUpdate);
    expect(at('other than Tenant #1')).toBeLessThan(firstUpdate);
    // The Tenant #1 fallback tier runs after every parent-derived tier.
    expect(
      at('FROM "GiftCardPurchase" AS g\n    JOIN "Customer"'),
    ).toBeLessThan(at('SET "tenantId" = tenant_one'));
    const lastCheck = at(
      "PaymentAttempt row(s) do not match their Location''s tenant",
    );
    expect(at('SET "tenantId" = tenant_one')).toBeLessThan(lastCheck);
    for (const table of CONVERTED) {
      expect(lastCheck).toBeLessThan(at(`ALTER TABLE "${table}"`));
    }
  });

  it('aborts, rolling everything back, when another tenant exists', async () => {
    await query(
      scratch.url,
      `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'test-tenant-b', 'B', 'ACTIVE', now())`,
      [TEST_TENANT_B_ID],
    );
    try {
      await expectAbort(
        scratch.url,
        /S0D-2C-1 aborted: 1 tenant\(s\) other than Tenant #1 exist/,
      );
      await allConvertedStillNull(scratch.url);
    } finally {
      await query(scratch.url, `DELETE FROM "Tenant" WHERE id = $1`, [
        TEST_TENANT_B_ID,
      ]);
    }
  });

  it('aborts when Tenant #1 is not ACTIVE', async () => {
    await query(
      scratch.url,
      `UPDATE "Tenant" SET status = 'SUSPENDED', "suspensionReason" = 'SECURITY' WHERE id = $1`,
      [T1],
    );
    try {
      await expectAbort(
        scratch.url,
        /S0D-2C-1 aborted: Tenant #1 is SUSPENDED/,
      );
      await allConvertedStillNull(scratch.url);
    } finally {
      await query(
        scratch.url,
        `UPDATE "Tenant" SET status = 'ACTIVE', "suspensionReason" = NULL WHERE id = $1`,
        [T1],
      );
    }
  });

  // Each consistency check, proven by planting one impossible row state.
  const plantedChecks: {
    name: string;
    plant: string;
    undo: string;
    message: RegExp;
  }[] = [
    {
      name: 'an Order that disagrees with its Location',
      // The Order's children carry the same value so the backfill has
      // nothing to propagate (the tenant FKs would otherwise fire first).
      plant: `UPDATE "Order" SET "tenantId" = 'ghost' WHERE id = 'ord-w';
              UPDATE "OrderLine" SET "tenantId" = 'ghost' WHERE id = 'ol-w';
              UPDATE "OrderStatusHistory" SET "tenantId" = 'ghost' WHERE id = 'osh-w';
              UPDATE "PaymentAttempt" SET "tenantId" = 'ghost' WHERE id = 'pa-order';`,
      undo: `UPDATE "Order" SET "tenantId" = NULL WHERE id = 'ord-w';
             UPDATE "OrderLine" SET "tenantId" = NULL WHERE id = 'ol-w';
             UPDATE "OrderStatusHistory" SET "tenantId" = NULL WHERE id = 'osh-w';
             UPDATE "PaymentAttempt" SET "tenantId" = NULL WHERE id = 'pa-order'`,
      message: /1 Order row\(s\) do not match their Location's tenant/,
    },
    {
      name: 'an Order that disagrees with its PaymentAttempt',
      plant: `UPDATE "PaymentAttempt" SET "tenantId" = 'ghost' WHERE id = 'pa-order';`,
      undo: `UPDATE "PaymentAttempt" SET "tenantId" = NULL WHERE id = 'pa-order'`,
      message: /1 Order row\(s\) do not match their PaymentAttempt's tenant/,
    },
    {
      name: 'an Order that disagrees with its Customer',
      // The tier-4 attempt is pre-attributed so the Customer's value is
      // not propagated (the tenant FK would otherwise fire first).
      plant: `UPDATE "Customer" SET "tenantId" = 'ghost' WHERE id = 'cust-w';
              UPDATE "PaymentAttempt" SET "tenantId" = '${T1}' WHERE id = 'pa-gc-c';`,
      undo: `UPDATE "Customer" SET "tenantId" = '${T1}' WHERE id = 'cust-w';
             UPDATE "PaymentAttempt" SET "tenantId" = NULL WHERE id = 'pa-gc-c'`,
      message: /1 Order row\(s\) do not match their Customer's tenant/,
    },
    {
      name: 'an OrderLine that disagrees with its Order',
      plant: `UPDATE "OrderLine" SET "tenantId" = 'ghost' WHERE id = 'ol-w';`,
      undo: `UPDATE "OrderLine" SET "tenantId" = NULL WHERE id = 'ol-w'`,
      message: /1 OrderLine row\(s\) do not match their Order's tenant/,
    },
    {
      name: 'an OrderStatusHistory row that disagrees with its Order',
      plant: `UPDATE "OrderStatusHistory" SET "tenantId" = 'ghost' WHERE id = 'osh-w';`,
      undo: `UPDATE "OrderStatusHistory" SET "tenantId" = NULL WHERE id = 'osh-w'`,
      message:
        /1 OrderStatusHistory row\(s\) do not match their Order's tenant/,
    },
    {
      name: 'a PaymentAttempt that disagrees with the Location it names',
      plant: `UPDATE "PaymentAttempt" SET "tenantId" = 'ghost' WHERE id = 'pa-loc';`,
      undo: `UPDATE "PaymentAttempt" SET "tenantId" = NULL WHERE id = 'pa-loc'`,
      message: /1 PaymentAttempt row\(s\) do not match their Location's tenant/,
    },
  ];
  for (const check of plantedChecks) {
    it(`aborts, rolling everything back, on ${check.name}`, async () => {
      await withoutFkChecks(scratch.url, check.plant);
      try {
        await expectAbort(scratch.url, check.message);
        const columns = await nullability(scratch.url);
        for (const table of CONVERTED) {
          expect(columns[table]).toBe('YES');
        }
      } finally {
        await withoutFkChecks(scratch.url, `${check.undo};`);
      }
      await allConvertedStillNull(scratch.url);
    });
  }

  it('when guards and checks pass: backfills every row through its tier and makes ONLY the four models NOT NULL, changing nothing else', async () => {
    const notices: string[] = [];
    await withScratchClient(scratch.url, async (client) => {
      client.on('notice', (n) => notices.push(n.message ?? ''));
      await client.query(target.sql);
    });

    const tier = (label: string) =>
      notices.find(
        (n) => n.includes(`PaymentAttempt -> `) && n.includes(label),
      );
    expect(tier('from Order')).toMatch(/-> 1 row\(s\)/);
    expect(tier('from Location')).toMatch(/-> 1 row\(s\)/);
    expect(tier('from GiftCardPurchase customer')).toMatch(/-> 1 row\(s\)/);
    expect(
      notices.find((n) =>
        /PaymentAttempt -> \d+ row\(s\) from GiftCardPurchase$/.test(n),
      ),
    ).toMatch(/-> 1 row\(s\)/);
    expect(tier('unattributable')).toMatch(/-> 1 unattributable row\(s\)/);

    for (const table of CONVERTED) {
      const ids = await tenantIds(scratch.url, table);
      for (const [id, tenantId] of Object.entries(ids)) {
        expect({ table, id, tenantId }).toEqual({ table, id, tenantId: T1 });
      }
    }
    // OutboxEvent is untouched: still nullable, and its window row keeps
    // its NULL tenant (that conversion is S0D-2C-2).
    expect(await tenantIds(scratch.url, 'OutboxEvent')).toEqual({
      'ev-w': null,
    });

    const columns = await nullability(scratch.url);
    for (const table of tenantTables) {
      expect({ table, nullable: columns[table] }).toEqual({
        table,
        nullable: REQUIRED_AFTER.has(table) ? 'NO' : 'YES',
      });
    }
    expect(tenantTables.filter((t) => columns[t] === 'NO')).toHaveLength(23);
    expect(tenantTables.filter((t) => columns[t] === 'YES')).toHaveLength(40);
    // Every model this slice made required stays in the testing package's
    // running list (later slices only ever extend it).
    expect(TENANT_ID_REQUIRED_MODELS).toEqual(
      expect.arrayContaining([...REQUIRED_AFTER]),
    );

    // No default, and no constraint / index / trigger / enum change.
    expect(await structure(scratch.url)).toEqual(structureBefore);
  });

  it('afterwards refuses tenantless rows in all four models', async () => {
    const attempts = [
      `INSERT INTO "PaymentAttempt" (id, "idempotencyKey", provider, amount, currency, "updatedAt") VALUES ('pa-x', 'k-x', 'fake', 1, 'USD', now())`,
      `INSERT INTO "Order" (id, "orderNumber", "accessToken", "locationId", "paymentAttemptId", "guestName", "guestPhone", currency, subtotal, "updatedAt")
         VALUES ('ord-x', 'X-1', 'tok-x', 'loc-w', 'pa-loc', 'G', '555', 'USD', 1, now())`,
      `INSERT INTO "OrderLine" (id, "orderId", "productId", "productName", "unitPrice", quantity, "lineTotal", currency, selections)
         VALUES ('ol-x', 'ord-w', 'p', 'P', 1, 1, 1, 'USD', '[]')`,
      `INSERT INTO "OrderStatusHistory" (id, "orderId", status) VALUES ('osh-x', 'ord-w', 'ACCEPTED')`,
    ];
    for (const sql of attempts) {
      await expect(applyMigrationSql(scratch.url, sql)).rejects.toThrow(
        /null value in column "tenantId"/,
      );
    }
  });
});
