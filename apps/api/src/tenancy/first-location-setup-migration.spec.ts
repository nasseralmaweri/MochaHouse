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

// SC4d — migration 20261108090000_first_location_setup, on scratch
// databases: existing locations stay valid with every profile field empty;
// the profile and opening-period checks; an opening period can never point
// at another business's location or move to another business; the built-in
// administrator role of every existing business receives locations.create
// (and no other role does); and a rollback that refuses while any profile
// or hours exist and otherwise removes everything the migration added.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261108090000_first_location_setup.down.sql',
);
const THIS = '20261108090000_first_location_setup';
const TENANT_A = '01a0db02-f800-7000-8000-5c4d0000a001';
const TENANT_B = '01a0db02-f800-7000-8000-5c4d0000b001';

jest.setTimeout(180_000);

describe('SC4d first location setup migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  let roles: { adminA: string; adminB: string; manager: string };
  let locationA: string;
  let locationB: string;
  const query = (text: string, params: unknown[] = []) =>
    withScratchClient(scratch.url, (c) =>
      c.query<Record<string, unknown> & { id: string }>(text, params),
    );

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4d_migration',
    );
    const all = listMigrations(MIGRATIONS);
    const at = all.findIndex((migration) => migration.name === THIS);
    expect(at).toBeGreaterThan(0);
    await applyMigrations(scratch.url, all.slice(0, at));

    // Before SC4d: two businesses, each with a location (no profile fields
    // exist yet), built-in administrator roles (one already holding the new
    // key) and a store-manager role.
    await withScratchClient(scratch.url, async (c) => {
      for (const [id, slug] of [
        [TENANT_A, 'sc4d-a'],
        [TENANT_B, 'sc4d-b'],
      ]) {
        await c.query(
          `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, $2, $2, 'ACTIVE', now())`,
          [id, slug],
        );
      }
      const location = async (tenantId: string) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO "Location" (id, "tenantId", name, slug, "updatedAt")
             VALUES (gen_random_uuid()::text, $1, 'Main', 'main', now()) RETURNING id`,
            [tenantId],
          )
        ).rows[0].id;
      locationA = await location(TENANT_A);
      locationB = await location(TENANT_B);
      const role = async (
        tenantId: string,
        key: string,
        permissions: string[],
      ) => {
        const id = (
          await c.query<{ id: string }>(
            `INSERT INTO "InternalRole" (id, "tenantId", key, "displayName", "isSystem", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $2, true, now()) RETURNING id`,
            [tenantId, key],
          )
        ).rows[0].id;
        for (const permissionKey of permissions) {
          await c.query(
            `INSERT INTO "InternalRolePermission" ("roleId", "permissionKey", "tenantId") VALUES ($1, $2, $3)`,
            [id, permissionKey, tenantId],
          );
        }
        return id;
      };
      roles = {
        adminA: await role(TENANT_A, 'platform-administrator', [
          'locations.edit',
        ]),
        // Already holds it: kept, never duplicated.
        adminB: await role(TENANT_B, 'platform-administrator', [
          'locations.create',
        ]),
        manager: await role(TENANT_A, 'store-manager', ['locations.view']),
      };
    });

    await applyMigrations(scratch.url, all.slice(at));
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('keeps existing locations valid with an empty profile and their online ordering unchanged', async () => {
    const rows = (
      await query(
        `SELECT "addressLine1", "timeZone", phone, "openingHoursSetAt", "isDigitalOrderingEnabled"
           FROM "Location" WHERE id = ANY($1)`,
        [[locationA, locationB]],
      )
    ).rows;
    expect(rows).toEqual([
      {
        addressLine1: null,
        timeZone: null,
        phone: null,
        openingHoursSetAt: null,
        isDigitalOrderingEnabled: true,
      },
      {
        addressLine1: null,
        timeZone: null,
        phone: null,
        openingHoursSetAt: null,
        isDigitalOrderingEnabled: true,
      },
    ]);
  });

  it('grants locations.create to every built-in administrator role, once, and to no other role', async () => {
    const grants = (
      await query(
        `SELECT "roleId" AS id, "tenantId" FROM "InternalRolePermission"
          WHERE "permissionKey" = 'locations.create' ORDER BY "tenantId"`,
      )
    ).rows;
    const byRole = new Map(grants.map((row) => [row.id, row.tenantId]));
    expect(byRole.get(roles.adminA)).toBe(TENANT_A);
    expect(byRole.get(roles.adminB)).toBe(TENANT_B);
    expect(byRole.has(roles.manager)).toBe(false);
    expect(grants.filter((row) => row.id === roles.adminB)).toHaveLength(1);
    // Tenant #1's built-in administrator (created by earlier migrations).
    const tenantOne = (
      await query(
        `SELECT count(*)::int AS n FROM "InternalRolePermission" p
           JOIN "InternalRole" r ON r.id = p."roleId"
          WHERE p."permissionKey" = 'locations.create' AND r."tenantId" = $1
            AND r.key = 'platform-administrator'`,
        [TENANT_1_MOCHA_HOUSE_ID],
      )
    ).rows[0];
    expect(tenantOne).toEqual({
      n: (
        await query(
          `SELECT count(*)::int AS n FROM "InternalRole" WHERE "tenantId" = $1 AND key = 'platform-administrator' AND "isSystem"`,
          [TENANT_1_MOCHA_HOUSE_ID],
        )
      ).rows[0].n,
    });
  });

  it('checks the profile fields', async () => {
    const set = (sql: string) =>
      query(`UPDATE "Location" SET ${sql} WHERE id = $1`, [locationA]);
    await expect(set(`"countryCode" = 'us'`)).rejects.toThrow();
    await expect(set(`"countryCode" = 'USA'`)).rejects.toThrow();
    await expect(set(`"addressLine1" = ''`)).rejects.toThrow();
    await expect(set(`phone = repeat('1', 31)`)).rejects.toThrow();
    await expect(set(`"timeZone" = repeat('x', 65)`)).rejects.toThrow();
  });

  it('checks opening periods and keeps them inside their business', async () => {
    const insert = (
      tenantId: string,
      locationId: string,
      day: number,
      opens: number,
      closes: number,
    ) =>
      query(
        `INSERT INTO "LocationOpeningPeriod" (id, "tenantId", "locationId", "dayOfWeek", "opensAtMinute", "closesAtMinute")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5) RETURNING id`,
        [tenantId, locationId, day, opens, closes],
      );
    for (const [day, opens, closes] of [
      [0, 600, 700],
      [8, 600, 700],
      [1, -1, 700],
      [1, 1440, 100],
      [1, 600, 0],
      [1, 600, 1441],
      [1, 600, 600],
    ]) {
      await expect(
        insert(TENANT_A, locationA, day, opens, closes),
      ).rejects.toThrow();
    }
    // Another business's location: refused by the composite foreign key.
    await expect(insert(TENANT_A, locationB, 1, 600, 700)).rejects.toThrow();

    const overnight = (await insert(TENANT_A, locationA, 5, 1080, 120)).rows[0]
      .id;
    await insert(TENANT_A, locationA, 2, 420, 1440);
    // The same opening time twice on one day is a duplicate.
    await expect(insert(TENANT_A, locationA, 2, 420, 600)).rejects.toThrow();
    // A period never moves to another business.
    await expect(
      query(
        `UPDATE "LocationOpeningPeriod" SET "tenantId" = $1 WHERE id = $2`,
        [TENANT_B, overnight],
      ),
    ).rejects.toThrow();
  });

  it('the rollback refuses while any profile or opening hours exist', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    expect(
      (
        await query(
          `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'LocationOpeningPeriod'`,
        )
      ).rows[0],
    ).toEqual({ n: 1 });
  });

  it('the rollback removes everything the migration added when nothing exists', async () => {
    const clean = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4d_rollback_clean',
    );
    try {
      await applyMigrations(clean.url, listMigrations(MIGRATIONS));
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      await withScratchClient(clean.url, async (c) => {
        const columns = await c.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_name = 'Location'
              AND column_name IN ('addressLine1', 'addressLine2', 'city', 'region', 'postalCode',
                                  'countryCode', 'timeZone', 'phone', 'openingHoursSetAt')`,
        );
        expect(columns.rows).toEqual([]);
        const tables = await c.query(
          `SELECT table_name FROM information_schema.tables WHERE table_name = 'LocationOpeningPeriod'`,
        );
        expect(tables.rows).toEqual([]);
        const grants = await c.query(
          `SELECT 1 FROM "InternalRolePermission" WHERE "permissionKey" = 'locations.create'`,
        );
        expect(grants.rows).toEqual([]);
      });
    } finally {
      await clean.drop();
    }
  });
});
