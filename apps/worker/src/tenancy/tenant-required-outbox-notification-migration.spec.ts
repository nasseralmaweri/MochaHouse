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

// Milestone S0D-2C-2 — the guarded, per-aggregate-type backfill + NOT NULL
// migration for OutboxEvent, followed by the guarded, parent-derived
// backfill + NOT NULL migration for NotificationDelivery, exercised on a
// throwaway scratch database starting from the exact post-S0D-2C-1B state.
//
// Unlike every prior S0D-2 slice, OutboxEvent has no single FK parent (it
// is a genuine, aggregate-agnostic outbox), so its backfill resolves each
// row against the table named by its OWN aggregateType — Order,
// JobApplication or FranchiseInquiry today. An unrecognized aggregateType
// or a referenced aggregate that no longer exists aborts the migration
// rather than guessing. There is no single-tenant guard and no Tenant #1
// fallback anywhere in this migration.

jest.setTimeout(180_000);

const repoRoot = join(__dirname, '../../../..');
const migrations = listMigrations(
  join(repoRoot, 'packages/database/prisma/migrations'),
);
const targetIndex = migrations.findIndex((m) =>
  m.name.endsWith('_require_tenant_id_outbox_notification'),
);
const before = migrations.slice(0, targetIndex);
const target = migrations[targetIndex];

const CONVERTED = ['OutboxEvent', 'NotificationDelivery'];
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
  'PaymentAttempt',
  'Order',
  'OrderLine',
  'OrderStatusHistory',
  'JobOpening',
  'JobApplication',
  'JobApplicationNote',
  'FranchiseInquiry',
  'FranchiseInquiryNote',
  'GiftCardPurchase',
  ...CONVERTED,
]);
const tenantTables = Object.entries(MODEL_TENANCY)
  .filter(([, tenancy]) => tenancy === 'tenant')
  .map(([model]) => model)
  // Milestone S0D-2C-3 added NotificationRecipient AFTER this migration;
  // this test is pinned to the schema exactly as it existed at `target`,
  // which never has that table. Excluded here rather than letting this
  // file's expected set silently grow with every later milestone.
  .filter((model) => model !== 'NotificationRecipient');

const baseUrl = process.env.DATABASE_URL!;
const T1 = TENANT_1_MOCHA_HOUSE_ID;

// Window rows: one OutboxEvent per known aggregateType (tenantId omitted,
// i.e. NULL — the nullable-window state), each pointing at a real
// aggregate row, plus one NotificationDelivery pointing at the Order
// event.
const WINDOW_ROWS_SQL = `
INSERT INTO "Location" (id, name, slug, "updatedAt", "tenantId")
  VALUES ('loc-on-w', 'Outbox Window', 'outbox-window', now(), '${T1}');
INSERT INTO "PaymentAttempt" (id, "idempotencyKey", provider, status, "locationId", amount, currency, "updatedAt", "tenantId")
  VALUES ('pa-on-w', 'k-on-w', 'fake', 'SUCCEEDED', 'loc-on-w', 400, 'USD', now(), '${T1}');
INSERT INTO "Order" (id, "orderNumber", "accessToken", "locationId", "paymentAttemptId", "guestName", "guestPhone", currency, subtotal, "updatedAt", "tenantId")
  VALUES ('ord-on-w', 'ON-W-1', 'tok-on-w', 'loc-on-w', 'pa-on-w', 'G', '555', 'USD', 400, now(), '${T1}');
INSERT INTO "JobOpening" (id, title, "employmentType", summary, description, responsibilities, qualifications, "updatedAt", "tenantId")
  VALUES ('job-on-w', 'Barista', 'FULL_TIME', 'S', 'D', 'R', 'Q', now(), '${T1}');
INSERT INTO "JobApplication" (id, "jobOpeningId", "jobTitleSnapshot", "firstName", "lastName", email, phone, location, "workAuthorized", availability, message, "updatedAt", "tenantId")
  VALUES ('app-on-w', 'job-on-w', 'Barista', 'Dana', 'Rivera', 'dana@example.com', '555', 'Austin', true, 'Any', 'M', now(), '${T1}');
INSERT INTO "FranchiseInquiry" (id, "firstName", "lastName", email, phone, city, state, country, "preferredMarket", "consentAcknowledged", "updatedAt", "tenantId")
  VALUES ('inq-on-w', 'Jordan', 'Lee', 'jordan@example.com', '555', 'Austin', 'TX', 'USA', 'Central Texas', true, now(), '${T1}');
INSERT INTO "OutboxEvent" (id, "aggregateType", "aggregateId", "eventType", payload)
  VALUES
    ('ev-order-w', 'Order', 'ord-on-w', 'order.checkout.completed', '{}'),
    ('ev-app-w', 'JobApplication', 'app-on-w', 'careers.application.submitted', '{}'),
    ('ev-inq-w', 'FranchiseInquiry', 'inq-on-w', 'franchising.inquiry.submitted', '{}');
INSERT INTO "NotificationDelivery" (id, "outboxEventId", channel, recipient, "templateKey", "aggregateType", "aggregateId")
  VALUES ('nd-on-w', 'ev-order-w', 'EMAIL', 'guest@example.com', 'order.received', 'Order', 'ord-on-w');
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

async function convertedStillNull(url: string) {
  const columns = await nullability(url);
  for (const table of CONVERTED) {
    expect({ table, nullable: columns[table] }).toEqual({
      table,
      nullable: 'YES',
    });
  }
}

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

async function withoutFkChecks(url: string, sql: string) {
  await applyMigrationSql(
    url,
    `SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`,
  );
}

async function expectAbort(url: string, message: RegExp) {
  await expect(applyMigrationSql(url, target.sql)).rejects.toThrow(message);
}

describe('S0D-2C-2 OutboxEvent & NotificationDelivery NOT NULL migration (scratch databases)', () => {
  let scratch: ScratchDatabase;
  let structureBefore: Awaited<ReturnType<typeof structure>>;

  beforeAll(async () => {
    scratch = await createScratchDatabase(baseUrl, 's0d2c2');
    await applyMigrations(scratch.url, before);
    await applyMigrationSql(scratch.url, WINDOW_ROWS_SQL);
    structureBefore = await structure(scratch.url);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('follows S0D-2C-1B, is atomic, alters ONLY OutboxEvent and NotificationDelivery, and carries no single-tenant guard', () => {
    expect(targetIndex).toBeGreaterThan(0);
    expect(before[before.length - 1].name).toMatch(
      /_require_tenant_id_gift_card_purchase$/,
    );
    expect(isAppliedAtomically(target.sql)).toBe(true);

    const altered = [
      ...target.sql.matchAll(
        /ALTER TABLE "(\w+)" ALTER COLUMN "tenantId" SET NOT NULL;/g,
      ),
    ].map((m) => m[1]);
    expect(altered).toEqual(CONVERTED);
    expect(target.sql).not.toMatch(
      /ADD VALUE|CREATE TYPE|DEFAULT|UNIQUE|FOREIGN KEY|CREATE TRIGGER|DROP TRIGGER|CREATE INDEX|DROP /,
    );
    expect(target.sql).not.toMatch(/other_tenants|tenant_one/);

    const at = (needle: string) => target.sql.indexOf(needle);
    const outboxAlter = at('ALTER TABLE "OutboxEvent"');
    const notificationBlock = at('$s0d2c2_notification$');
    const notificationAlter = at('ALTER TABLE "NotificationDelivery"');
    // OutboxEvent is fully resolved (guard -> backfill -> checks -> NOT
    // NULL) strictly before NotificationDelivery's own block even starts.
    expect(outboxAlter).toBeLessThan(notificationBlock);
    expect(notificationBlock).toBeLessThan(notificationAlter);
  });

  it('succeeds even with a second tenant present — there is no single-tenant assumption to violate', async () => {
    await query(
      scratch.url,
      `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, 'test-tenant-b', 'B', 'ACTIVE', now())`,
      [TEST_TENANT_B_ID],
    );
    try {
      await expect(applyMigrationSql(scratch.url, target.sql)).resolves.toBeUndefined();
    } finally {
      await query(scratch.url, `ALTER TABLE "OutboxEvent" ALTER COLUMN "tenantId" DROP NOT NULL`);
      await query(scratch.url, `ALTER TABLE "NotificationDelivery" ALTER COLUMN "tenantId" DROP NOT NULL`);
      await query(scratch.url, `UPDATE "OutboxEvent" SET "tenantId" = NULL WHERE id IN ('ev-order-w','ev-app-w','ev-inq-w')`);
      await query(scratch.url, `UPDATE "NotificationDelivery" SET "tenantId" = NULL WHERE id = 'nd-on-w'`);
      await query(scratch.url, `DELETE FROM "Tenant" WHERE id = $1`, [TEST_TENANT_B_ID]);
    }
    await convertedStillNull(scratch.url);
  });

  describe('OutboxEvent guards', () => {
    const plantedChecks: {
      name: string;
      plant: string;
      undo: string;
      message: RegExp;
    }[] = [
      {
        name: 'a non-null OutboxEvent.tenantId that disagrees with its Order',
        plant: `UPDATE "OutboxEvent" SET "tenantId" = 'ghost' WHERE id = 'ev-order-w';`,
        undo: `UPDATE "OutboxEvent" SET "tenantId" = NULL WHERE id = 'ev-order-w'`,
        message:
          /1 OutboxEvent row\(s\) \(aggregateType Order\) have a non-null tenantId that disagrees with their Order's tenant/,
      },
      {
        name: 'a non-null OutboxEvent.tenantId that disagrees with its JobApplication',
        plant: `UPDATE "OutboxEvent" SET "tenantId" = 'ghost' WHERE id = 'ev-app-w';`,
        undo: `UPDATE "OutboxEvent" SET "tenantId" = NULL WHERE id = 'ev-app-w'`,
        message:
          /1 OutboxEvent row\(s\) \(aggregateType JobApplication\) have a non-null tenantId that disagrees with their JobApplication's tenant/,
      },
      {
        name: 'a non-null OutboxEvent.tenantId that disagrees with its FranchiseInquiry',
        plant: `UPDATE "OutboxEvent" SET "tenantId" = 'ghost' WHERE id = 'ev-inq-w';`,
        undo: `UPDATE "OutboxEvent" SET "tenantId" = NULL WHERE id = 'ev-inq-w'`,
        message:
          /1 OutboxEvent row\(s\) \(aggregateType FranchiseInquiry\) have a non-null tenantId that disagrees with their FranchiseInquiry's tenant/,
      },
      {
        name: 'an unrecognized aggregateType',
        plant: `INSERT INTO "OutboxEvent" (id, "aggregateType", "aggregateId", "eventType", payload) VALUES ('ev-unknown-w', 'SomePlatformThing', 'does-not-matter', 'platform.something.happened', '{}');`,
        undo: `DELETE FROM "OutboxEvent" WHERE id = 'ev-unknown-w'`,
        message:
          /1 OutboxEvent row\(s\) have an unrecognized aggregateType with no tenant resolution path/,
      },
      {
        name: 'a known aggregateType whose referenced aggregate no longer exists',
        plant: `INSERT INTO "OutboxEvent" (id, "aggregateType", "aggregateId", "eventType", payload) VALUES ('ev-missing-w', 'Order', 'ffffffff-ffff-7fff-afff-ffffffffffff', 'order.checkout.completed', '{}');`,
        undo: `DELETE FROM "OutboxEvent" WHERE id = 'ev-missing-w'`,
        message:
          /1 OutboxEvent row\(s\) reference a missing aggregate and could not resolve a tenant/,
      },
    ];
    for (const check of plantedChecks) {
      it(`aborts, rolling everything back, on ${check.name}`, async () => {
        await withoutFkChecks(scratch.url, check.plant);
        try {
          await expectAbort(scratch.url, check.message);
          const columns = await nullability(scratch.url);
          expect(columns.OutboxEvent).toBe('YES');
        } finally {
          await withoutFkChecks(scratch.url, `${check.undo};`);
        }
        await convertedStillNull(scratch.url);
      });
    }
  });

  describe('NotificationDelivery guard', () => {
    it('aborts, rolling everything back, on a non-null NotificationDelivery.tenantId that disagrees with its OutboxEvent', async () => {
      await withoutFkChecks(
        scratch.url,
        `UPDATE "NotificationDelivery" SET "tenantId" = 'ghost' WHERE id = 'nd-on-w';`,
      );
      try {
        await expectAbort(
          scratch.url,
          /1 NotificationDelivery row\(s\) have a non-null tenantId that disagrees with their OutboxEvent's tenant/,
        );
        const columns = await nullability(scratch.url);
        expect(columns.NotificationDelivery).toBe('YES');
        // OutboxEvent's own block runs first and would otherwise have
        // already succeeded and committed within this same transaction —
        // confirm the NotificationDelivery failure rolled THAT back too.
        expect(columns.OutboxEvent).toBe('YES');
      } finally {
        await withoutFkChecks(
          scratch.url,
          `UPDATE "NotificationDelivery" SET "tenantId" = NULL WHERE id = 'nd-on-w';`,
        );
      }
      await convertedStillNull(scratch.url);
    });
  });

  it('a row whose tenantId is already correctly set is left unchanged by the backfill', async () => {
    // Pre-set ev-order-w to its true, agreeing value (T1) BEFORE running
    // the migration — the disagreement check must pass (it already
    // agrees) and the backfill's `WHERE tenantId IS NULL` must skip it
    // rather than touching it.
    await query(
      scratch.url,
      `UPDATE "OutboxEvent" SET "tenantId" = $1 WHERE id = 'ev-order-w'`,
      [T1],
    );
    try {
      const notices: string[] = [];
      await withScratchClient(scratch.url, async (client) => {
        client.on('notice', (n) => notices.push(n.message ?? ''));
        await client.query(target.sql);
      });
      // Only the OTHER two Order-table-less rows needed backfilling from
      // their own tiers; ev-order-w was already set and is not among them.
      const orderTier = notices.find(
        (n) => n.includes('OutboxEvent -> ') && n.includes('from Order'),
      );
      expect(orderTier).toMatch(/-> 0 row\(s\) from Order/);
      expect((await tenantIds(scratch.url, 'OutboxEvent'))['ev-order-w']).toBe(
        T1,
      );
    } finally {
      // Roll the scratch DB back to the pre-migration nullable state for
      // the remaining tests.
      await query(scratch.url, `ALTER TABLE "OutboxEvent" ALTER COLUMN "tenantId" DROP NOT NULL`);
      await query(scratch.url, `ALTER TABLE "NotificationDelivery" ALTER COLUMN "tenantId" DROP NOT NULL`);
      await query(scratch.url, `UPDATE "OutboxEvent" SET "tenantId" = NULL WHERE id IN ('ev-order-w','ev-app-w','ev-inq-w')`);
      await query(scratch.url, `UPDATE "NotificationDelivery" SET "tenantId" = NULL WHERE id = 'nd-on-w'`);
    }
    await convertedStillNull(scratch.url);
  });

  it('when every check passes: backfills OutboxEvent per aggregateType, then NotificationDelivery from it, and makes ONLY these two NOT NULL', async () => {
    const notices: string[] = [];
    await withScratchClient(scratch.url, async (client) => {
      client.on('notice', (n) => notices.push(n.message ?? ''));
      await client.query(target.sql);
    });

    expect(
      notices.find((n) => n.includes('OutboxEvent -> ') && n.includes('from Order')),
    ).toMatch(/-> 1 row\(s\) from Order/);
    expect(
      notices.find(
        (n) => n.includes('OutboxEvent -> ') && n.includes('from JobApplication'),
      ),
    ).toMatch(/-> 1 row\(s\) from JobApplication/);
    expect(
      notices.find(
        (n) => n.includes('OutboxEvent -> ') && n.includes('from FranchiseInquiry'),
      ),
    ).toMatch(/-> 1 row\(s\) from FranchiseInquiry/);
    expect(
      notices.find((n) => n.includes('NotificationDelivery -> ')),
    ).toMatch(/-> 1 row\(s\) from OutboxEvent/);

    expect(await tenantIds(scratch.url, 'OutboxEvent')).toEqual({
      'ev-order-w': T1,
      'ev-app-w': T1,
      'ev-inq-w': T1,
    });
    expect(await tenantIds(scratch.url, 'NotificationDelivery')).toEqual({
      'nd-on-w': T1,
    });

    // Every other Gift Card / loyalty / promotion model, and every other
    // untouched domain, stays nullable.
    expect((await nullability(scratch.url)).GiftCard).toBe('YES');
    expect((await nullability(scratch.url)).GiftCardTransaction).toBe('YES');

    const columns = await nullability(scratch.url);
    for (const table of tenantTables) {
      expect({ table, nullable: columns[table] }).toEqual({
        table,
        nullable: REQUIRED_AFTER.has(table) ? 'NO' : 'YES',
      });
    }
    expect(tenantTables.filter((t) => columns[t] === 'NO')).toHaveLength(31);
    expect(tenantTables.filter((t) => columns[t] === 'YES')).toHaveLength(32);
    expect(TENANT_ID_REQUIRED_MODELS).toEqual(
      expect.arrayContaining([...REQUIRED_AFTER]),
    );

    expect(await structure(scratch.url)).toEqual(structureBefore);
  });

  it('afterwards refuses a tenantless OutboxEvent and a tenantless NotificationDelivery', async () => {
    await expect(
      applyMigrationSql(
        scratch.url,
        `INSERT INTO "OutboxEvent" (id, "aggregateType", "aggregateId", "eventType", payload)
           VALUES ('ev-x', 'Order', 'ord-on-w', 'order.checkout.completed', '{}')`,
      ),
    ).rejects.toThrow(/null value in column "tenantId"/);

    await expect(
      applyMigrationSql(
        scratch.url,
        `INSERT INTO "NotificationDelivery" (id, "outboxEventId", channel, recipient, "templateKey", "aggregateType", "aggregateId")
           VALUES ('nd-x', 'ev-order-w', 'EMAIL', 'x@example.com', 'order.received', 'Order', 'ord-on-w')`,
      ),
    ).rejects.toThrow(/null value in column "tenantId"/);
  });
});
