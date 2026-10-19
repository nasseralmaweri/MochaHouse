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

// ESP-04 M1 — migration 20261120090000_restaurant_payment_accounts on scratch
// databases: payments.connect is granted to the built-in administrator roles
// only; a business has at most one payment account and an account belongs to
// one business; test mode only; a recorded account id never changes and the
// record is never deleted; each Connect event is recorded once; the preflight
// refuses without the ownership guard; and the rollback refuses while any
// record exists.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const THIS_MIGRATION = '20261120090000_restaurant_payment_accounts';
const ROLLBACK = join(
  __dirname,
  `../../../../packages/database/prisma/rollbacks/${THIS_MIGRATION}.down.sql`,
);
const T1 = TENANT_1_MOCHA_HOUSE_ID;
const OTHER = '01a0db02-f800-7000-8000-c5a0000000b9';

jest.setTimeout(300_000);

describe('ESP-04 M1 restaurant payment accounts migration (scratch database)', () => {
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
  const account = (
    scratch: ScratchDatabase,
    id: string,
    values: {
      tenantId?: string;
      externalAccountId?: string | null;
      livemode?: boolean;
      userId?: string;
    } = {},
  ) =>
    run(
      scratch,
      `INSERT INTO "TenantPaymentAccount" (id, "tenantId", provider, livemode, "externalAccountId", "connectedByInternalUserId", "updatedAt")
       VALUES ($1, $2, 'stripe', $3, $4, $5, now())`,
      [
        id,
        values.tenantId ?? T1,
        values.livemode ?? false,
        values.externalAccountId === undefined
          ? `acct_${id.replace(/[^A-Za-z0-9]/g, '')}`
          : values.externalAccountId,
        values.userId ?? 'user-1',
      ],
    );

  it('is listed after every earlier migration', () => {
    expect(at).toBeGreaterThan(0);
  });

  describe('applied', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp04_m1_accounts',
      );
      await applyMigrations(scratch.url, before);
      await run(
        scratch,
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt")
         VALUES ($1, 'm1-other', 'Other Business', 'ACTIVE', now()) ON CONFLICT DO NOTHING`,
        [OTHER],
      );
      for (const [id, tenantId] of [
        ['user-1', T1],
        ['user-other', OTHER],
      ]) {
        await run(
          scratch,
          `INSERT INTO "InternalUser" (id, "tenantId", "externalProvider", "externalSubject", email, status, "updatedAt")
           VALUES ($1, $2, 'internal-dev', $1, $1 || '@example.test', 'ACTIVE', now())`,
          [id, tenantId],
        );
      }
      for (const [id, tenantId, key, isSystem] of [
        ['role-admin', T1, 'platform-administrator', true],
        ['role-admin-other', OTHER, 'platform-administrator', true],
        ['role-manager', T1, 'store-manager', true],
        ['role-custom', T1, 'platform-administrator-copy', false],
      ] as const) {
        await run(
          scratch,
          `INSERT INTO "InternalRole" (id, "tenantId", key, "displayName", "isSystem", "updatedAt")
           VALUES ($1, $2, $3, $1, $4, now()) ON CONFLICT DO NOTHING`,
          [id, tenantId, key, isSystem],
        );
      }
      await applyMigrations(scratch.url, thisOne);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('grants payments.connect to every built-in administrator role and no other role', async () => {
      const { rows } = await run(
        scratch,
        `SELECT r.id FROM "InternalRolePermission" p JOIN "InternalRole" r ON r.id = p."roleId"
          WHERE p."permissionKey" = 'payments.connect' AND r.id LIKE 'role-%' ORDER BY r.id`,
      );
      expect(rows).toEqual([{ id: 'role-admin' }, { id: 'role-admin-other' }]);
    });

    it('one account per business, one business per account, test mode only, valid account ids', async () => {
      await account(scratch, 'pa-1');
      await expect(
        account(scratch, 'pa-dup', { externalAccountId: 'acct_other1' }),
      ).rejects.toThrow(/unique/);
      await expect(
        account(scratch, 'pa-x', {
          tenantId: OTHER,
          userId: 'user-other',
          externalAccountId: 'acct_pa1',
        }),
      ).rejects.toThrow(/unique/);
      for (const [i, values] of [
        { livemode: true },
        { externalAccountId: 'not-an-account' },
      ].entries()) {
        await expect(
          account(scratch, `pa-bad-${i}`, {
            tenantId: OTHER,
            userId: 'user-other',
            ...values,
          }),
        ).rejects.toThrow(/check constraint/);
      }
      // The connecting staff member belongs to the same business.
      await expect(
        account(scratch, 'pa-cross', { tenantId: OTHER, userId: 'user-1' }),
      ).rejects.toThrow(/foreign key/);
    });

    it('a recorded account never changes, moves or disappears; its status does update', async () => {
      await run(
        scratch,
        `UPDATE "TenantPaymentAccount" SET "cardPaymentsStatus" = 'active', "lastSyncedAt" = now() WHERE id = 'pa-1'`,
      );
      await expect(
        run(
          scratch,
          `UPDATE "TenantPaymentAccount" SET "externalAccountId" = 'acct_swapped' WHERE id = 'pa-1'`,
        ),
      ).rejects.toThrow(/never changes/);
      await expect(
        run(
          scratch,
          `UPDATE "TenantPaymentAccount" SET "tenantId" = $1 WHERE id = 'pa-1'`,
          [OTHER],
        ),
      ).rejects.toThrow();
      await expect(
        run(scratch, `DELETE FROM "TenantPaymentAccount" WHERE id = 'pa-1'`),
      ).rejects.toThrow(/never deleted/);
      // A record created before its account exists gets its id once.
      await account(scratch, 'pa-new', {
        tenantId: OTHER,
        userId: 'user-other',
        externalAccountId: null,
      });
      await run(
        scratch,
        `UPDATE "TenantPaymentAccount" SET "externalAccountId" = 'acct_new1' WHERE id = 'pa-new'`,
      );
      await expect(
        run(
          scratch,
          `UPDATE "TenantPaymentAccount" SET "externalAccountId" = NULL WHERE id = 'pa-new'`,
        ),
      ).rejects.toThrow(/never changes/);
    });

    it('records each provider event once', async () => {
      const insert = (id: string, eventId: string) =>
        run(
          scratch,
          `INSERT INTO "RestaurantPaymentProviderEvent" (id, provider, "externalEventId", type, livemode, "payloadDigest")
           VALUES ($1, 'stripe', $2, 'account.updated', false, $3)`,
          [id, eventId, 'a'.repeat(64)],
        );
      await insert('ev-1', 'evt_1');
      await expect(insert('ev-2', 'evt_1')).rejects.toThrow(/unique/);
      await expect(
        run(
          scratch,
          `INSERT INTO "RestaurantPaymentProviderEvent" (id, provider, "externalEventId", type, livemode, "payloadDigest", status)
           VALUES ('ev-3', 'stripe', 'evt_3', 't', false, $1, 'DONE')`,
          ['b'.repeat(64)],
        ),
      ).rejects.toThrow(/check constraint/);
    });

    it('the rollback refuses while any record exists, changing nothing', async () => {
      await expect(
        applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
      ).rejects.toThrow(/rollback refused/);
      const { rows } = await run(
        scratch,
        `SELECT to_regclass('"TenantPaymentAccount"') IS NOT NULL AS present`,
      );
      expect(rows).toEqual([{ present: true }]);
    });
  });

  describe('rollback with nothing to keep', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp04_m1_rollback',
      );
      await applyMigrations(scratch.url, [...before, ...thisOne]);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('removes the tables, the guard and the permission grants', async () => {
      await applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8'));
      const { rows } = await run(
        scratch,
        `SELECT to_regclass('"TenantPaymentAccount"') IS NULL AS accounts_gone,
                to_regclass('"RestaurantPaymentProviderEvent"') IS NULL AS events_gone,
                to_regprocedure('payment_account_guard()') IS NULL AS guard_gone,
                (SELECT count(*)::int FROM "InternalRolePermission" WHERE "permissionKey" = 'payments.connect') AS grants`,
      );
      expect(rows).toEqual([
        { accounts_gone: true, events_gone: true, guard_gone: true, grants: 0 },
      ]);
    });
  });

  describe('preflight', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp04_m1_preflight',
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
          `SELECT to_regclass('"TenantPaymentAccount"') IS NULL AS absent`,
        );
        expect(rows).toEqual([{ absent: true }]);
      } finally {
        await run(
          scratch,
          `ALTER FUNCTION reject_tenant_reassignment_hidden() RENAME TO reject_tenant_reassignment`,
        );
      }
    });
  });
});
