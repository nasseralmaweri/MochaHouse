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

// ESP-03 PR 5 — migration 20261116090000_payment_reconciliation_support on
// scratch databases: existing cases, events and operator grants come through
// unchanged; the two payments.reconciliation.* permissions become grantable
// (nothing else new is); a support note is bounded, belongs to a case of its
// own business, never moves and can never be edited or deleted; the preflight
// refuses (changing nothing) when the ownership guard is missing; and the
// rollback refuses while any note or payments.reconciliation grant exists,
// otherwise restoring the previous permission list.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const THIS_MIGRATION = '20261116090000_payment_reconciliation_support';
const ROLLBACK = join(
  __dirname,
  `../../../../packages/database/prisma/rollbacks/${THIS_MIGRATION}.down.sql`,
);
const T1 = TENANT_1_MOCHA_HOUSE_ID;
const OTHER = '01a0db02-f800-7000-8000-c5a0000000b5';

jest.setTimeout(300_000);

describe('ESP-03 PR 5 payment reconciliation support migration (scratch database)', () => {
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
  const operator = async (scratch: ScratchDatabase, tag: string) =>
    (
      await run(
        scratch,
        `INSERT INTO "PlatformOperator" (id, "externalProvider", "externalSubject", email, status, "updatedAt")
         VALUES (gen_random_uuid()::text, 'platform-dev', $1, $2, 'ACTIVE', now()) RETURNING id`,
        [`platform-dev:${tag}`, `${tag}@example.test`],
      )
    ).rows[0].id as string;
  const grant = (
    scratch: ScratchDatabase,
    operatorId: string,
    permission: string,
  ) =>
    run(
      scratch,
      `INSERT INTO "PlatformOperatorPermission" (id, "operatorId", permission, "grantReason")
       VALUES (gen_random_uuid()::text, $1, $2, 'Migration test grant reason')`,
      [operatorId, permission],
    );
  const seedCase = async (
    scratch: ScratchDatabase,
    suffix: string,
    tenantId = T1,
  ) => {
    await run(
      scratch,
      `INSERT INTO "PaymentAttempt" (id, "tenantId", "idempotencyKey", provider, amount, currency, "updatedAt")
       VALUES ($1, $2, $3, 'fake', 500, 'USD', now())`,
      [`pa-${suffix}`, tenantId, `key-${suffix}`],
    );
    await run(
      scratch,
      `INSERT INTO "PaymentReconciliationCase" (id, "paymentAttemptId", "reasonCode", "updatedAt", "tenantId")
       VALUES ($1, $2, 'FULFILMENT_FAILED', now(), $3)`,
      [`case-${suffix}`, `pa-${suffix}`, tenantId],
    );
    await run(
      scratch,
      `INSERT INTO "PaymentReconciliationEvent" (id, "caseId", "actorKind", action, "tenantId")
       VALUES ($1, $2, 'SYSTEM', 'OPENED', $3)`,
      [`ev-${suffix}`, `case-${suffix}`, tenantId],
    );
  };
  const note = (
    scratch: ScratchDatabase,
    id: string,
    caseId: string,
    values: { tenantId?: string; body?: string; author?: string } = {},
  ) =>
    run(
      scratch,
      `INSERT INTO "PaymentReconciliationNote" (id, "caseId", "authorPlatformOperatorId", body, "tenantId")
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        caseId,
        values.author ?? 'operator-1',
        values.body ?? 'Checked the provider dashboard.',
        values.tenantId ?? T1,
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
    let operatorId: string;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp03_pr5_support',
      );
      await applyMigrations(scratch.url, before);
      await run(
        scratch,
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt")
         VALUES ($1, 'support-other', 'Other Business', 'ACTIVE', now())
         ON CONFLICT DO NOTHING`,
        [OTHER],
      );
      await seedCase(scratch, 't1');
      await seedCase(scratch, 'other', OTHER);
      operatorId = await operator(scratch, 'esp03-pr5-existing');
      await grant(scratch, operatorId, 'storefront.manage');
      await applyMigrations(scratch.url, thisOne);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('leaves existing cases, their history and operator grants exactly as they were', async () => {
      const { rows } = await run(
        scratch,
        `SELECT c.id, c.status, c."reasonCode", count(e.id)::int AS events
         FROM "PaymentReconciliationCase" c
         LEFT JOIN "PaymentReconciliationEvent" e ON e."caseId" = c.id
         GROUP BY c.id ORDER BY c.id`,
      );
      expect(rows).toEqual([
        {
          id: 'case-other',
          status: 'OPEN',
          reasonCode: 'FULFILMENT_FAILED',
          events: 1,
        },
        {
          id: 'case-t1',
          status: 'OPEN',
          reasonCode: 'FULFILMENT_FAILED',
          events: 1,
        },
      ]);
      expect(
        (
          await run(
            scratch,
            `SELECT permission FROM "PlatformOperatorPermission" WHERE "operatorId" = $1`,
            [operatorId],
          )
        ).rows,
      ).toEqual([{ permission: 'storefront.manage' }]);
      expect(await count(scratch, 'PaymentReconciliationNote')).toBe(0);
    });

    it('makes exactly the two payments.reconciliation permissions grantable', async () => {
      await grant(scratch, operatorId, 'payments.reconciliation.view');
      await grant(scratch, operatorId, 'payments.reconciliation.manage');
      await expect(
        grant(scratch, operatorId, 'payments.reconciliation.refund'),
      ).rejects.toThrow(/check constraint/);
      await expect(
        grant(scratch, operatorId, 'payments.admin'),
      ).rejects.toThrow(/check constraint/);
    });

    it('bounds a note: 1–1000 characters, not blank', async () => {
      await note(scratch, 'n-ok', 'case-t1');
      await note(scratch, 'n-max', 'case-t1', { body: 'x'.repeat(1000) });
      for (const [id, body] of [
        ['n-empty', ''],
        ['n-blank', '   \n '],
        ['n-long', 'x'.repeat(1001)],
      ]) {
        await expect(note(scratch, id, 'case-t1', { body })).rejects.toThrow(
          /check constraint/,
        );
      }
      await expect(
        note(scratch, 'n-author', 'case-t1', { author: '' }),
      ).rejects.toThrow(/check constraint/);
    });

    it('belongs to a case of its own business and never moves', async () => {
      // A note naming another business's case.
      await expect(
        note(scratch, 'n-cross', 'case-other', { tenantId: T1 }),
      ).rejects.toThrow(/foreign key/);
      await expect(
        run(
          scratch,
          `UPDATE "PaymentReconciliationNote" SET "tenantId" = $1 WHERE id = 'n-ok'`,
          [OTHER],
        ),
      ).rejects.toThrow();
    });

    it('is append-only: a note can never be edited or deleted, and its case cannot go', async () => {
      await expect(
        run(
          scratch,
          `UPDATE "PaymentReconciliationNote" SET body = 'edited' WHERE id = 'n-ok'`,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        run(
          scratch,
          `DELETE FROM "PaymentReconciliationNote" WHERE id = 'n-ok'`,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        run(
          scratch,
          `DELETE FROM "PaymentReconciliationCase" WHERE id = 'case-t1'`,
        ),
      ).rejects.toThrow();
      expect(await count(scratch, 'PaymentReconciliationNote')).toBe(2);
    });

    it('the rollback refuses while notes or payments.reconciliation grants exist, changing nothing', async () => {
      await expect(
        applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
      ).rejects.toThrow(/rollback refused/);
      expect(await count(scratch, 'PaymentReconciliationNote')).toBe(2);
      // The new permissions are still accepted (the CHECK was not touched).
      const second = await operator(scratch, 'esp03-pr5-after-refusal');
      await grant(scratch, second, 'payments.reconciliation.view');
    });
  });

  describe('rollback with nothing to keep', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp03_pr5_rollback',
      );
      await applyMigrations(scratch.url, [...before, ...thisOne]);
    });

    afterAll(async () => {
      await scratch?.drop();
    });

    it('removes the notes table and restores the previous permission list', async () => {
      await applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8'));
      const { rows } = await run(
        scratch,
        `SELECT to_regclass('"PaymentReconciliationNote"') IS NULL AS gone,
                to_regprocedure('reject_payment_reconciliation_note_change()') IS NULL AS fn_gone`,
      );
      expect(rows).toEqual([{ gone: true, fn_gone: true }]);
      const id = await operator(scratch, 'esp03-pr5-rolled-back');
      await expect(
        grant(scratch, id, 'payments.reconciliation.view'),
      ).rejects.toThrow(/check constraint/);
      await grant(scratch, id, 'storefront.manage');
    });
  });

  describe('preflight', () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await createScratchDatabase(
        process.env.DATABASE_URL!,
        'esp03_pr5_preflight',
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
          `SELECT to_regclass('"PaymentReconciliationNote"') IS NULL AS absent`,
        );
        expect(rows).toEqual([{ absent: true }]);
        const id = await operator(scratch, 'esp03-pr5-preflight');
        await expect(
          grant(scratch, id, 'payments.reconciliation.view'),
        ).rejects.toThrow(/check constraint/);
      } finally {
        await run(
          scratch,
          `ALTER FUNCTION reject_tenant_reassignment_hidden() RENAME TO reject_tenant_reassignment`,
        );
      }
    });
  });
});
