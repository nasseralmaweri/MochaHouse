import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { MODEL_TENANCY, TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  isAppliedAtomically,
  listMigrations,
  withScratchClient,
  type MigrationFile,
  type ScratchDatabase,
} from '@mocha-house/testing';

// Milestone S0D-1 — the expand + backfill migration, exercised ONLY against
// throwaway scratch databases (never the shared development database).
// Migrations are applied exactly as Prisma 7 applies them on PostgreSQL
// (verified from the server statement log): each file as ONE simple-protocol
// query — one implicit transaction — except enum-adding files, which Prisma
// sends statement by statement (see applyMigrationSql).

jest.setTimeout(180_000);

const repoRoot = join(__dirname, '../../../..');
const databasePackage = join(repoRoot, 'packages/database');
const migrations = listMigrations(join(databasePackage, 'prisma/migrations'));
const s0d1Index = migrations.findIndex((m) =>
  m.name.endsWith('_add_tenant_id_columns'),
);
const beforeS0d1: MigrationFile[] = migrations.slice(0, s0d1Index);
const s0d1 = migrations[s0d1Index];

const tenantTables = Object.entries(MODEL_TENANCY)
  .filter(([, tenancy]) => tenancy === 'tenant')
  .map(([model]) => model)
  .sort();

const baseUrl = process.env.DATABASE_URL!;

async function tenantIdColumnCount(url: string): Promise<number> {
  return withScratchClient(url, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'tenantId'`,
    );
    return Number(rows[0].count);
  });
}

// Per-table { rows, nulls, tenantOne } for every tenant-owned table.
async function tenantOwnership(url: string) {
  return withScratchClient(url, async (client) => {
    const result: Record<
      string,
      { rows: number; nulls: number; tenantOne: number }
    > = {};
    for (const table of tenantTables) {
      const { rows } = await client.query<{
        rows: string;
        nulls: string;
        tenant_one: string;
      }>(
        `SELECT COUNT(*) AS rows,
                COUNT(*) FILTER (WHERE "tenantId" IS NULL) AS nulls,
                COUNT(*) FILTER (WHERE "tenantId" = $1) AS tenant_one
         FROM "${table}"`,
        [TENANT_1_MOCHA_HOUSE_ID],
      );
      result[table] = {
        rows: Number(rows[0].rows),
        nulls: Number(rows[0].nulls),
        tenantOne: Number(rows[0].tenant_one),
      };
    }
    return result;
  });
}

// A representative pre-S0D-1 dataset: catalog + joins, a customer with an
// order, lines, status history, payment, the append-only Mocha Bean and
// gift-card ledgers, authorization rows, audit, a keyed singleton and the
// outbox — inserted in the PRE-migration shape (no tenantId column yet).
const REPRESENTATIVE_ROWS: Record<string, number> = {
  Location: 2,
  Category: 1,
  Product: 1,
  Menu: 1,
  MenuProduct: 1,
  LocationMenu: 1,
  Customer: 1,
  PaymentAttempt: 1,
  Order: 1,
  OrderLine: 2,
  OrderStatusHistory: 1,
  CustomerLoyaltyAccount: 1,
  MochaBeanLedgerEntry: 1,
  GiftCard: 1,
  GiftCardTransaction: 1,
  InternalUser: 1,
  InternalRole: 1,
  InternalRolePermission: 1,
  InternalUserRoleAssignment: 1,
  InternalAuditEvent: 1,
  LoyaltyConfiguration: 1,
  OutboxEvent: 1,
};

const REPRESENTATIVE_SQL = `
INSERT INTO "Location" (id, name, slug, "updatedAt") VALUES
  ('loc-1', 'Loc One', 'loc-one', now()), ('loc-2', 'Loc Two', 'loc-two', now());
INSERT INTO "Category" (id, name, slug, "updatedAt") VALUES ('cat-1', 'Coffee', 'coffee', now());
INSERT INTO "Product" (id, name, slug, "categoryId", "updatedAt") VALUES ('prod-1', 'Drip', 'drip', 'cat-1', now());
INSERT INTO "Menu" (id, name, slug, "updatedAt") VALUES ('menu-1', 'Main', 'main', now());
INSERT INTO "MenuProduct" ("menuId", "productId") VALUES ('menu-1', 'prod-1');
INSERT INTO "LocationMenu" ("locationId", "menuId") VALUES ('loc-1', 'menu-1');
INSERT INTO "Customer" (id, "externalProvider", "externalSubject", "updatedAt") VALUES ('cust-1', 'dev', 'dev:a', now());
INSERT INTO "PaymentAttempt" (id, "idempotencyKey", provider, amount, currency, "updatedAt")
  VALUES ('pay-1', 'idem-1', 'fake', 700, 'USD', now());
INSERT INTO "Order" (id, "orderNumber", "accessToken", "locationId", "customerId", "paymentAttemptId",
                     "guestName", "guestPhone", currency, subtotal, "updatedAt")
  VALUES ('ord-1', 'ABC234', 'tok-1', 'loc-1', 'cust-1', 'pay-1', 'Sam', '5550000000', 'USD', 700, now());
INSERT INTO "OrderLine" (id, "orderId", "productId", "productName", "unitPrice", quantity, "lineTotal", currency, selections)
  VALUES ('line-1', 'ord-1', 'prod-1', 'Drip', 350, 1, 350, 'USD', '[]'),
         ('line-2', 'ord-1', 'prod-1', 'Drip', 350, 1, 350, 'USD', '[]');
INSERT INTO "OrderStatusHistory" (id, "orderId", status) VALUES ('osh-1', 'ord-1', 'RECEIVED');
INSERT INTO "CustomerLoyaltyAccount" (id, "customerId", balance, "updatedAt") VALUES ('acct-1', 'cust-1', 7, now());
INSERT INTO "MochaBeanLedgerEntry" (id, "loyaltyAccountId", type, amount, "orderId") VALUES ('bean-1', 'acct-1', 'EARN', 7, 'ord-1');
INSERT INTO "GiftCard" (id, "codeHash", last4, "originalValueMinorUnits", "balanceMinorUnits", "updatedAt")
  VALUES ('gc-1', 'hash-1', '4821', 2500, 2500, now());
INSERT INTO "InternalUser" (id, "externalProvider", email, "updatedAt") VALUES ('iu-1', 'internal-dev', 'a@example.com', now());
INSERT INTO "GiftCardTransaction" (id, "giftCardId", type, "amountMinorUnits", "balanceAfterMinorUnits", "actorInternalUserId")
  VALUES ('gct-1', 'gc-1', 'ISSUANCE', 2500, 2500, 'iu-1');
INSERT INTO "InternalRole" (id, key, "displayName", "updatedAt") VALUES ('role-1', 'owner', 'Owner', now());
INSERT INTO "InternalRolePermission" ("roleId", "permissionKey") VALUES ('role-1', 'orders.view');
INSERT INTO "InternalUserRoleAssignment" (id, "internalUserId", "roleId", "scopeType", "updatedAt")
  VALUES ('asg-1', 'iu-1', 'role-1', 'CORPORATE', now());
INSERT INTO "InternalAuditEvent" (id, "actorInternalUserId", action, "targetType", "targetId", reason)
  VALUES ('aud-1', 'iu-1', 'user.status_changed', 'internal_user', 'iu-1', 'test');
INSERT INTO "LoyaltyConfiguration" (id, key, "updatedAt") VALUES ('cfg-1', 'company', now());
INSERT INTO "OutboxEvent" (id, "aggregateType", "aggregateId", "eventType", payload)
  VALUES ('evt-1', 'Order', 'ord-1', 'order.checkout.completed', '{}');
`;

describe('S0D-1 tenant columns migration (scratch databases)', () => {
  it('finds the S0D-1 migration after the S0C tenant foundation', () => {
    expect(s0d1Index).toBeGreaterThan(0);
    expect(
      beforeS0d1.some((m) => m.name.endsWith('_add_tenant_foundation')),
    ).toBe(true);
  });

  it('is applied by Prisma as ONE atomic unit (no enum value additions), so a failed guard rolls back everything', () => {
    // If this ever fails, Prisma would apply the file statement by statement
    // and the ADD COLUMNs before a failing guard would NOT be rolled back.
    expect(isAppliedAtomically(s0d1.sql)).toBe(true);
  });

  it('runs every guard before the first backfill UPDATE, and backfill before indexes/FKs', () => {
    const at = (needle: string) => s0d1.sql.indexOf(needle);
    const lastAddColumn = s0d1.sql.lastIndexOf('ADD COLUMN');
    expect(at('does not exist')).toBeGreaterThan(lastAddColumn);
    expect(at('other than Tenant #1')).toBeLessThan(at('UPDATE %I SET'));
    expect(at('not ACTIVE')).toBeLessThan(at('UPDATE %I SET'));
    expect(at('UPDATE %I SET')).toBeLessThan(at('-- CreateIndex'));
    expect(at('-- CreateIndex')).toBeLessThan(at('-- AddForeignKey'));
    expect(s0d1.sql).not.toMatch(/DEFAULTs+'01a0db02/i);
  });

  describe('against a database in the exact pre-S0D-1 state', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(baseUrl, 's0d1_pre');
      await applyMigrations(scratch.url, beforeS0d1);
      await applyMigrationSql(scratch.url, REPRESENTATIVE_SQL);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    // Each abort case sets up its condition, proves the whole migration was
    // rolled back (no tenantId column survives), then restores the state.
    it('aborts, and rolls back every statement, when another tenant exists', async () => {
      await withScratchClient(scratch.url, (client) =>
        client.query(
          `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt")
           VALUES ($1, 'test-tenant-b', 'B', 'ACTIVE', now())`,
          [TEST_TENANT_B_ID],
        ),
      );
      try {
        await expect(applyMigrationSql(scratch.url, s0d1.sql)).rejects.toThrow(
          /tenant\(s\) other than Tenant #1 exist/,
        );
        expect(await tenantIdColumnCount(scratch.url)).toBe(0);
      } finally {
        await withScratchClient(scratch.url, (client) =>
          client.query(`DELETE FROM "Tenant" WHERE id = $1`, [
            TEST_TENANT_B_ID,
          ]),
        );
      }
    });

    it('aborts when Tenant #1 is missing', async () => {
      const [tenantOne] = await withScratchClient(
        scratch.url,
        async (client) => {
          const { rows } = await client.query(
            `SELECT * FROM "Tenant" WHERE id = $1`,
            [TENANT_1_MOCHA_HOUSE_ID],
          );
          await client.query(`DELETE FROM "Tenant" WHERE id = $1`, [
            TENANT_1_MOCHA_HOUSE_ID,
          ]);
          return rows as { slug: string; name: string }[];
        },
      );
      try {
        await expect(applyMigrationSql(scratch.url, s0d1.sql)).rejects.toThrow(
          /Tenant #1 \(01a0db02-f800-7000-8000-000000000001\) does not exist/,
        );
        expect(await tenantIdColumnCount(scratch.url)).toBe(0);
      } finally {
        await withScratchClient(scratch.url, (client) =>
          client.query(
            `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt")
             VALUES ($1, $2, $3, 'ACTIVE', now())`,
            [TENANT_1_MOCHA_HOUSE_ID, tenantOne.slug, tenantOne.name],
          ),
        );
      }
    });

    it('aborts when Tenant #1 is not ACTIVE', async () => {
      await withScratchClient(scratch.url, (client) =>
        client.query(
          `UPDATE "Tenant" SET status = 'SUSPENDED', "suspensionReason" = 'SECURITY' WHERE id = $1`,
          [TENANT_1_MOCHA_HOUSE_ID],
        ),
      );
      try {
        await expect(applyMigrationSql(scratch.url, s0d1.sql)).rejects.toThrow(
          /Tenant #1 is SUSPENDED, not ACTIVE/,
        );
        expect(await tenantIdColumnCount(scratch.url)).toBe(0);
      } finally {
        await withScratchClient(scratch.url, (client) =>
          client.query(
            `UPDATE "Tenant" SET status = 'ACTIVE', "suspensionReason" = NULL WHERE id = $1`,
            [TENANT_1_MOCHA_HOUSE_ID],
          ),
        );
      }
    });

    it('when every guard passes, assigns every existing row to Tenant #1 and leaves no NULL', async () => {
      await applyMigrationSql(scratch.url, s0d1.sql);

      expect(await tenantIdColumnCount(scratch.url)).toBe(63);
      const ownership = await tenantOwnership(scratch.url);

      for (const table of tenantTables) {
        const expectedRows = REPRESENTATIVE_ROWS[table] ?? 0;
        expect({ table, ...ownership[table] }).toEqual({
          table,
          rows: expectedRows,
          nulls: 0,
          tenantOne: expectedRows,
        });
      }
    });
  });

  describe('fresh database: all migrations, then the seed twice', () => {
    let scratch: ScratchDatabase;

    const runSeed = () =>
      execFileSync(process.execPath, ['--import', 'tsx', 'prisma/seed.ts'], {
        cwd: databasePackage,
        env: { ...process.env, DATABASE_URL: scratch.url },
        stdio: 'pipe',
      });

    beforeAll(async () => {
      scratch = await createScratchDatabase(baseUrl, 's0d1_fresh');
      await applyMigrations(scratch.url, migrations);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('applies cleanly to an empty database (only the migration-inserted Tenant #1 exists)', async () => {
      const tenants = await withScratchClient(scratch.url, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM "Tenant"`,
        );
        return rows.map((row) => row.id);
      });
      expect(tenants).toEqual([TENANT_1_MOCHA_HOUSE_ID]);
    });

    it('seeds every tenant-owned row with Tenant #1 explicitly, and is idempotent', async () => {
      runSeed();
      const first = await tenantOwnership(scratch.url);

      const seededTables = tenantTables.filter(
        (table) => first[table].rows > 0,
      );
      expect(seededTables.length).toBeGreaterThan(10);
      for (const table of tenantTables) {
        expect({
          table,
          nulls: first[table].nulls,
          other: first[table].rows - first[table].tenantOne,
        }).toEqual({ table, nulls: 0, other: 0 });
      }

      runSeed();
      const second = await tenantOwnership(scratch.url);
      expect(second).toEqual(first);

      const tenantCount = await withScratchClient(
        scratch.url,
        async (client) => {
          const { rows } = await client.query<{ count: string }>(
            `SELECT COUNT(*) AS count FROM "Tenant"`,
          );
          return Number(rows[0].count);
        },
      );
      expect(tenantCount).toBe(1);
    });
  });
});
