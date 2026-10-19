import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';

// ESP-03 PR 1 — the additive payment-recovery database foundation:
// PaymentAttempt."paymentState" / "fulfilmentStatus" (nullable, CHECKed),
// PaymentReconciliationCase and the append-only PaymentReconciliationEvent.
// Exercised through the REAL migration SQL (and its rollback) against scratch
// databases created and marked by the disposable-database guard — the same
// pattern as the other tenant migration suites, with no Prisma CLI spawn.

jest.setTimeout(300_000);

const databasePackage = join(__dirname, '../../../../packages/database');
const migrations = listMigrations(join(databasePackage, 'prisma/migrations'));
const targetIndex = migrations.findIndex((m) =>
  m.name.endsWith('_payment_recovery_foundation'),
);
const beforeTarget = migrations.slice(0, targetIndex);
const target = migrations[targetIndex];
// The follow-up migration that VALIDATEs the two PaymentAttempt CHECKs the
// foundation migration adds NOT VALID.
const validate = migrations.find((m) =>
  m.name.endsWith('_payment_recovery_validate_checks'),
)!;
const rollbackSql = readFileSync(
  join(
    databasePackage,
    'prisma/rollbacks/20261017090000_payment_recovery_foundation.down.sql',
  ),
  'utf8',
);
const baseUrl = process.env.DATABASE_URL!;

const A = '01a0db02-f800-7000-8000-7e570000a001';
const B = '01a0db02-f800-7000-8000-7e570000b002';

// Legacy rows as the application created them BEFORE this migration (no
// paymentState / fulfilmentStatus columns exist yet).
const OLD = `now() - interval '3 hours'`;
const attempt = (
  id: string,
  tenantId: string,
  status: string,
  updatedAt: string,
  extra = '',
) =>
  `INSERT INTO "PaymentAttempt" (id, "idempotencyKey", provider, status, amount, currency, "updatedAt", "tenantId"${extra ? ', ' + extra.split('|')[0] : ''})
   VALUES ('${id}', 'key-${id}', 'fake', '${status}', 500, 'USD', ${updatedAt}, '${tenantId}'${extra ? ', ' + extra.split('|')[1] : ''})`;
const order = (id: string, tenantId: string, attemptId: string) =>
  `INSERT INTO "Order" (id, "orderNumber", "accessToken", "locationId", "paymentAttemptId", "guestName", "guestPhone", currency, subtotal, "updatedAt", "tenantId")
   VALUES ('o-${id}', 'N-${id}', 'tok-${id}', 'loc-${tenantId}', '${attemptId}', 'G', '555', 'USD', 500, now(), '${tenantId}')`;
const purchase = (
  id: string,
  tenantId: string,
  attemptId: string,
  status: string,
  claimed: boolean,
  cardId: string | null,
) =>
  `INSERT INTO "GiftCardPurchase" (id, "amountMinorUnits", "paymentAttemptId", "purchaserEmail", "updatedAt", "tenantId", status, "chargeClaimedAt", "giftCardId")
   VALUES ('gp-${id}', 2500, '${attemptId}', 'b@example.test', now(), '${tenantId}', '${status}', ${claimed ? 'now()' : 'NULL'}, ${cardId ? `'${cardId}'` : 'NULL'})`;

const LEGACY_FIXTURES = [
  `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ('${A}', 'tenant-a', 'A', 'ACTIVE', now()), ('${B}', 'tenant-b', 'B', 'ACTIVE', now())`,
  `INSERT INTO "Location" (id, name, slug, "updatedAt", "tenantId") VALUES ('loc-${A}', 'LA', 'la', now(), '${A}'), ('loc-${B}', 'LB', 'lb', now(), '${B}')`,
  `INSERT INTO "InternalUser" (id, "externalProvider", email, "updatedAt", "tenantId") VALUES ('iu-a', 'internal-dev', 'a@example.test', now(), '${A}'), ('iu-b', 'internal-dev', 'b@example.test', now(), '${B}')`,
  // 1. stuck checkout, old PENDING -> UNKNOWN + case
  attempt('p-old', A, 'PENDING', OLD),
  // 2. fresh PENDING (maybe in flight) -> untouched
  attempt('p-new', A, 'PENDING', 'now()'),
  // 3. abandoned gift-card intent (charge never claimed) -> untouched
  attempt('p-gc-abandoned', A, 'PENDING', OLD),
  purchase('abandoned', A, 'p-gc-abandoned', 'PENDING', false, null),
  // 4. gift-card charge claimed, then stuck PENDING -> UNKNOWN + case
  attempt('p-gc-stuck', A, 'PENDING', OLD),
  purchase('stuck', A, 'p-gc-stuck', 'PENDING', true, null),
  // 5. succeeded with an order -> untouched
  attempt('s-order', A, 'SUCCEEDED', OLD),
  order('s-order', A, 's-order'),
  // 6. succeeded gift card, issued -> untouched
  attempt('s-gc-ok', A, 'SUCCEEDED', OLD),
  `INSERT INTO "GiftCard" (id, "codeHash", last4, "originalValueMinorUnits", "updatedAt", "tenantId") VALUES ('gc-1', 'hash-1', '0001', 2500, now(), '${A}')`,
  purchase('ok', A, 's-gc-ok', 'ISSUED', true, 'gc-1'),
  // 7. succeeded, nothing created, old -> NEEDS_REVIEW + case
  attempt('s-orphan-old', A, 'SUCCEEDED', OLD),
  // 8. succeeded, nothing created, flagged, recent -> NEEDS_REVIEW + case
  attempt(
    's-orphan-flagged',
    A,
    'SUCCEEDED',
    'now()',
    '"reconciliationRequired", "reconciliationReason"|true, \'order failed\'',
  ),
  // 9. succeeded, nothing created, unflagged, recent -> untouched (in flight)
  attempt('s-orphan-new', A, 'SUCCEEDED', 'now()'),
  // 10. succeeded gift card flagged for reconciliation, no card -> case
  attempt('s-gc-flagged', A, 'SUCCEEDED', OLD),
  purchase('flagged', A, 's-gc-flagged', 'RECONCILIATION_REQUIRED', true, null),
  // 11. resolved failures -> untouched (never reclassified)
  attempt('d-declined', A, 'DECLINED', OLD),
  attempt('f-failed', A, 'FAILED', OLD),
  // 12. another business's stuck PENDING -> case in THAT business
  attempt('p-old-b', B, 'PENDING', OLD),
];

const EXPECTED_CASES: Record<string, [string, string, string | null]> = {
  // attempt id: [reasonCode, tenantId, expected fulfilmentStatus]
  'p-old': ['LEGACY_PENDING_UNRESOLVED', A, null],
  'p-gc-stuck': ['LEGACY_PENDING_UNRESOLVED', A, null],
  's-orphan-old': ['LEGACY_SUCCEEDED_UNFULFILLED', A, 'NEEDS_REVIEW'],
  's-orphan-flagged': ['LEGACY_SUCCEEDED_UNFULFILLED', A, 'NEEDS_REVIEW'],
  's-gc-flagged': ['LEGACY_SUCCEEDED_UNFULFILLED', A, 'NEEDS_REVIEW'],
  'p-old-b': ['LEGACY_PENDING_UNRESOLVED', B, null],
};
const UNTOUCHED = [
  'p-new',
  'p-gc-abandoned',
  's-order',
  's-gc-ok',
  's-orphan-new',
  'd-declined',
  'f-failed',
];

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

// The legacy view of every attempt: nothing the migration may change.
const legacySnapshot = (url: string) =>
  rows(
    url,
    `SELECT id, status::text AS status, "reconciliationRequired", amount, "providerReference", "failureReason", "tenantId"
       FROM "PaymentAttempt" ORDER BY id`,
  );
const caseSnapshot = (url: string) =>
  rows<{ attempt: string; reason: string; tenant: string; status: string }>(
    url,
    `SELECT "paymentAttemptId" AS attempt, "reasonCode" AS reason, "tenantId" AS tenant, status
       FROM "PaymentReconciliationCase" ORDER BY "paymentAttemptId"`,
  );

describe('ESP-03 PR 1: payment recovery database foundation', () => {
  const scratches: ScratchDatabase[] = [];
  const fresh = async (label: string) => {
    const scratch = await createScratchDatabase(baseUrl, label);
    scratches.push(scratch);
    return scratch;
  };
  afterAll(async () => {
    for (const scratch of scratches) await scratch.drop();
  });

  // One populated database, migrated once, shared by the read-only checks.
  let populated: ScratchDatabase;
  let legacyBefore: Awaited<ReturnType<typeof legacySnapshot>>;

  beforeAll(async () => {
    populated = await fresh('esp03_populated');
    await applyMigrations(populated.url, beforeTarget);
    for (const statement of LEGACY_FIXTURES)
      await run(populated.url, statement);
    legacyBefore = await legacySnapshot(populated.url);
    await applyMigrationSql(populated.url, target.sql);
  });

  describe('fresh database', () => {
    it('adds nullable state columns, empty reconciliation tables and the checks', async () => {
      const scratch = await fresh('esp03_fresh');
      await applyMigrations(scratch.url, migrations);
      const columns = await rows<{ c: string; n: string; t: string }>(
        scratch.url,
        `SELECT column_name AS c, is_nullable AS n, data_type AS t FROM information_schema.columns
          WHERE table_name = 'PaymentAttempt' AND column_name IN ('paymentState', 'fulfilmentStatus')
          ORDER BY 1`,
      );
      expect(columns).toEqual([
        { c: 'fulfilmentStatus', n: 'YES', t: 'text' },
        { c: 'paymentState', n: 'YES', t: 'text' },
      ]);
      expect(
        await rows(scratch.url, `SELECT 1 FROM "PaymentReconciliationCase"`),
      ).toHaveLength(0);
      expect(
        await rows(scratch.url, `SELECT 1 FROM "PaymentReconciliationEvent"`),
      ).toHaveLength(0);
      // The checks of the tables this migration created (ESP-03 PR 5's
      // PaymentReconciliationNote, created later, has its own suite).
      const checks = await rows<{ n: string }>(
        scratch.url,
        `SELECT conname AS n FROM pg_constraint
          WHERE contype = 'c'
            AND (conname LIKE 'PaymentAttempt\\_%'
              OR conname LIKE 'PaymentReconciliationCase\\_%'
              OR conname LIKE 'PaymentReconciliationEvent\\_%')`,
      );
      expect(checks.map((c) => c.n).sort()).toEqual([
        'PaymentAttempt_fulfilmentStatus_check',
        'PaymentAttempt_paymentState_check',
        'PaymentReconciliationCase_reasonCode_check',
        'PaymentReconciliationCase_resolution_check',
        'PaymentReconciliationCase_resolved_consistency_check',
        'PaymentReconciliationCase_status_check',
        'PaymentReconciliationEvent_action_check',
        'PaymentReconciliationEvent_actorKind_check',
        'PaymentReconciliationEvent_actor_consistency_check',
        'PaymentReconciliationEvent_detail_check',
      ]);
    });
  });

  describe('populated legacy database: conservative backfill', () => {
    it('changes no legacy column on any attempt', async () => {
      expect(await legacySnapshot(populated.url)).toEqual(legacyBefore);
    });

    it('opens a case only for stuck PENDING and unfulfilled SUCCEEDED attempts', async () => {
      const cases = await caseSnapshot(populated.url);
      expect(
        Object.fromEntries(cases.map((c) => [c.attempt, [c.reason, c.tenant]])),
      ).toEqual(
        Object.fromEntries(
          Object.entries(EXPECTED_CASES).map(([id, [reason, tenant]]) => [
            id,
            [reason, tenant],
          ]),
        ),
      );
      expect(cases.every((c) => c.status === 'OPEN')).toBe(true);
    });

    it('classifies an unresolved payment UNKNOWN — never FAILED or DECLINED', async () => {
      const states = await rows<{
        id: string;
        s: string | null;
        f: string | null;
      }>(
        populated.url,
        `SELECT id, "paymentState" AS s, "fulfilmentStatus" AS f FROM "PaymentAttempt" ORDER BY id`,
      );
      const byId = Object.fromEntries(states.map((r) => [r.id, r]));
      for (const [id, [reason, , fulfilment]] of Object.entries(
        EXPECTED_CASES,
      )) {
        expect([id, byId[id].s, byId[id].f]).toEqual([
          id,
          reason === 'LEGACY_PENDING_UNRESOLVED' ? 'UNKNOWN' : 'SUCCEEDED',
          fulfilment,
        ]);
      }
      for (const id of UNTOUCHED) {
        expect([id, byId[id].s, byId[id].f]).toEqual([id, null, null]);
      }
      expect(
        states.filter((r) => r.s === 'FAILED' || r.s === 'DECLINED'),
      ).toEqual([]);
    });

    it('records one SYSTEM OPENED event per case, from the migration', async () => {
      const events = await rows<{
        k: string;
        a: string;
        n: string;
        s: string;
      }>(
        populated.url,
        `SELECT "actorKind" AS k, action AS a, count(*)::text AS n, "detail" ->> 'source' AS s
           FROM "PaymentReconciliationEvent" GROUP BY 1, 2, 4`,
      );
      expect(events).toEqual([
        {
          k: 'SYSTEM',
          a: 'OPENED',
          n: String(Object.keys(EXPECTED_CASES).length),
          s: 'migration',
        },
      ]);
    });

    it('keeps each case, its attempt and its events inside one business', async () => {
      const mismatches = await rows(
        populated.url,
        `SELECT c.id FROM "PaymentReconciliationCase" c
           JOIN "PaymentAttempt" a ON a.id = c."paymentAttemptId" WHERE a."tenantId" <> c."tenantId"
         UNION ALL
         SELECT e.id FROM "PaymentReconciliationEvent" e
           JOIN "PaymentReconciliationCase" c ON c.id = e."caseId" WHERE c."tenantId" <> e."tenantId"`,
      );
      expect(mismatches).toEqual([]);
      const perTenant = await rows<{ t: string; n: string }>(
        populated.url,
        `SELECT "tenantId" AS t, count(*)::text AS n FROM "PaymentReconciliationCase" GROUP BY 1 ORDER BY 1`,
      );
      expect(perTenant).toEqual([
        { t: A, n: '5' },
        { t: B, n: '1' },
      ]);
    });
  });

  describe('constraints', () => {
    const insertCase = (
      id: string,
      attemptId: string,
      tenant: string,
      extra = '',
    ) =>
      `INSERT INTO "PaymentReconciliationCase" (id, "paymentAttemptId", "reasonCode", "updatedAt", "tenantId"${extra ? ', ' + extra.split('|')[0] : ''})
       VALUES ('${id}', '${attemptId}', 'MANUAL_REVIEW', now(), '${tenant}'${extra ? ', ' + extra.split('|')[1] : ''})`;

    it('rejects unknown state values on PaymentAttempt (23514)', async () => {
      for (const set of [
        `"paymentState" = 'BOGUS'`,
        `"paymentState" = 'failed'`,
        `"fulfilmentStatus" = 'DONE-ISH'`,
      ]) {
        expect(
          await sqlState(
            populated.url,
            `UPDATE "PaymentAttempt" SET ${set} WHERE id = 'p-new'`,
          ),
        ).toBe('23514');
      }
      expect(
        await sqlState(
          populated.url,
          `UPDATE "PaymentAttempt" SET "paymentState" = 'CHARGING', "fulfilmentStatus" = 'PENDING' WHERE id = 'p-new'`,
        ),
      ).toBeNull();
      await run(
        populated.url,
        `UPDATE "PaymentAttempt" SET "paymentState" = NULL, "fulfilmentStatus" = NULL WHERE id = 'p-new'`,
      );
    });

    it('allows one case per attempt (23505) and requires a consistent resolution (23514)', async () => {
      expect(await sqlState(populated.url, insertCase('dup', 'p-old', A))).toBe(
        '23505',
      );
      expect(
        await sqlState(populated.url, insertCase('c-ok', 'p-new', A)),
      ).toBeNull();
      for (const [id, attemptId, extra] of [
        ['bad-1', 's-order', `status|'RESOLVED'`],
        ['bad-2', 's-order', `status, resolution|'RESOLVED', 'FULFILLED'`],
        ['bad-3', 's-order', `resolution|'FULFILLED'`],
        ['bad-4', 's-order', `status|'DONE'`],
        [
          'bad-5',
          's-order',
          `resolution, status, "resolvedAt"|'MAYBE', 'RESOLVED', now()`,
        ],
      ]) {
        expect([
          id,
          await sqlState(populated.url, insertCase(id, attemptId, A, extra)),
        ]).toEqual([id, '23514']);
      }
      expect(
        await sqlState(
          populated.url,
          insertCase(
            'c-resolved',
            's-order',
            A,
            `status, resolution, "resolvedAt"|'RESOLVED', 'NOT_CHARGED', now()`,
          ),
        ),
      ).toBeNull();
    });

    it('requires a machine reason code and a machine action (23514)', async () => {
      for (const reason of ['lowercase', 'Has Space', '', "X'; DROP"]) {
        expect(
          await sqlState(
            populated.url,
            `INSERT INTO "PaymentReconciliationCase" (id, "paymentAttemptId", "reasonCode", "updatedAt", "tenantId")
             VALUES ('r-${reason.length}', 's-gc-ok', '${reason.replace(/'/g, "''")}', now(), '${A}')`,
          ),
        ).toBe('23514');
      }
      expect(
        await sqlState(
          populated.url,
          `INSERT INTO "PaymentReconciliationEvent" (id, "caseId", "actorKind", action, "tenantId")
           SELECT 'ev-bad', id, 'SYSTEM', 'not machine', "tenantId" FROM "PaymentReconciliationCase" LIMIT 1`,
        ),
      ).toBe('23514');
    });

    it('ties the actor to the actor kind and keeps detail an object (23514)', async () => {
      const event = (kind: string, actor: string, detail: string) =>
        `INSERT INTO "PaymentReconciliationEvent" (id, "caseId", "actorKind", "actorInternalUserId", action, detail, "tenantId")
         SELECT 'ev-${kind}-${actor.length}-${detail.length}', c.id, '${kind}', ${actor}, 'NOTE', ${detail}, c."tenantId"
           FROM "PaymentReconciliationCase" c WHERE c."tenantId" = '${A}' LIMIT 1`;
      expect(await sqlState(populated.url, event('USER', 'NULL', 'NULL'))).toBe(
        '23514',
      );
      expect(
        await sqlState(populated.url, event('SYSTEM', `'iu-a'`, 'NULL')),
      ).toBe('23514');
      expect(
        await sqlState(populated.url, event('SYSTEM', 'NULL', `'[1]'::jsonb`)),
      ).toBe('23514');
      expect(
        await sqlState(
          populated.url,
          event('USER', `'iu-a'`, `'{"a":1}'::jsonb`),
        ),
      ).toBeNull();
      expect(
        await sqlState(populated.url, event('SYSTEM', 'NULL', 'NULL')),
      ).toBeNull();
    });

    it('composite foreign keys refuse every cross-business link (23503)', async () => {
      // A case in business B naming business A's attempt.
      expect(
        await sqlState(populated.url, insertCase('x-attempt', 's-gc-ok', B)),
      ).toBe('23503');
      // An assignee from the other business.
      expect(
        await sqlState(
          populated.url,
          insertCase(
            'x-assignee',
            'f-failed',
            A,
            `"assigneeInternalUserId"|'iu-b'`,
          ),
        ),
      ).toBe('23503');
      expect(
        await sqlState(
          populated.url,
          insertCase(
            'ok-assignee',
            'd-declined',
            A,
            `"assigneeInternalUserId"|'iu-a'`,
          ),
        ),
      ).toBeNull();
      // An event naming a case or an actor of another business.
      const caseOfA = (
        await rows<{ id: string }>(
          populated.url,
          `SELECT id FROM "PaymentReconciliationCase" WHERE "tenantId" = '${A}' LIMIT 1`,
        )
      )[0].id;
      expect(
        await sqlState(
          populated.url,
          `INSERT INTO "PaymentReconciliationEvent" (id, "caseId", "actorKind", action, "tenantId")
           VALUES ('x-event', '${caseOfA}', 'SYSTEM', 'NOTE', '${B}')`,
        ),
      ).toBe('23503');
      expect(
        await sqlState(
          populated.url,
          `INSERT INTO "PaymentReconciliationEvent" (id, "caseId", "actorKind", "actorInternalUserId", action, "tenantId")
           VALUES ('x-actor', '${caseOfA}', 'USER', 'iu-b', 'NOTE', '${A}')`,
        ),
      ).toBe('23503');
    });

    it('refuses a change of tenantId (23001) and deleting an attempt that has a case (23503)', async () => {
      expect(
        await sqlState(
          populated.url,
          `UPDATE "PaymentReconciliationCase" SET "tenantId" = '${B}' WHERE "paymentAttemptId" = 'p-old'`,
        ),
      ).toBe('23001');
      expect(
        await sqlState(
          populated.url,
          `UPDATE "PaymentReconciliationEvent" SET "tenantId" = '${B}'`,
        ),
      ).toBe('23001');
      expect(
        await sqlState(
          populated.url,
          `DELETE FROM "PaymentAttempt" WHERE id = 'p-old'`,
        ),
      ).toBe('23503');
    });

    it('makes the event history append-only (UPDATE and DELETE rejected, 23001) and keeps a case that has events (23503)', async () => {
      expect(
        await sqlState(
          populated.url,
          `UPDATE "PaymentReconciliationEvent" SET action = 'EDITED'`,
        ),
      ).toBe('23001');
      expect(
        await sqlState(
          populated.url,
          `DELETE FROM "PaymentReconciliationEvent"`,
        ),
      ).toBe('23001');
      expect(
        await sqlState(
          populated.url,
          `DELETE FROM "PaymentReconciliationCase" WHERE "paymentAttemptId" = 'p-old'`,
        ),
      ).toBe('23503'); // its OPENED event still references it (ON DELETE RESTRICT)
    });
  });

  describe('PaymentAttempt CHECKs: NOT VALID first, validated without a long lock', () => {
    const state = (url: string) =>
      rows<{ n: string; v: boolean }>(
        url,
        `SELECT conname AS n, convalidated AS v FROM pg_constraint
          WHERE conrelid = '"PaymentAttempt"'::regclass
            AND conname IN ('PaymentAttempt_paymentState_check', 'PaymentAttempt_fulfilmentStatus_check')
          ORDER BY 1`,
      );

    it('adds both CHECKs NOT VALID (enforced for writes, no scan), then the second migration validates them', async () => {
      const scratch = await fresh('esp03_notvalid');
      await applyMigrations(scratch.url, beforeTarget);
      for (const statement of LEGACY_FIXTURES)
        await run(scratch.url, statement);
      await applyMigrationSql(scratch.url, target.sql);

      expect(await state(scratch.url)).toEqual([
        { n: 'PaymentAttempt_fulfilmentStatus_check', v: false },
        { n: 'PaymentAttempt_paymentState_check', v: false },
      ]);
      // Not validated, but already enforced for new and updated rows.
      expect(
        await sqlState(
          scratch.url,
          `UPDATE "PaymentAttempt" SET "paymentState" = 'BOGUS' WHERE id = 'p-new'`,
        ),
      ).toBe('23514');
      const attempts = await rows(
        scratch.url,
        `SELECT * FROM "PaymentAttempt" ORDER BY id`,
      );

      await applyMigrationSql(scratch.url, validate.sql);
      expect(await state(scratch.url)).toEqual([
        { n: 'PaymentAttempt_fulfilmentStatus_check', v: true },
        { n: 'PaymentAttempt_paymentState_check', v: true },
      ]);
      // Validation changes no data, and is a harmless no-op the second time.
      expect(
        await rows(scratch.url, `SELECT * FROM "PaymentAttempt" ORDER BY id`),
      ).toEqual(attempts);
      await applyMigrationSql(scratch.url, validate.sql);
      expect(await state(scratch.url)).toEqual([
        { n: 'PaymentAttempt_fulfilmentStatus_check', v: true },
        { n: 'PaymentAttempt_paymentState_check', v: true },
      ]);
    });

    it('the validation migration refuses to run without the foundation, changing nothing', async () => {
      const scratch = await fresh('esp03_novalidate');
      await applyMigrations(scratch.url, beforeTarget);
      await expect(
        applyMigrationSql(scratch.url, validate.sql),
      ).rejects.toThrow(/requires the foundation migration/);
    });

    it('rolls back cleanly whether or not the constraints were ever validated', async () => {
      const scratch = await fresh('esp03_rb_notvalid');
      await applyMigrations(scratch.url, beforeTarget);
      await applyMigrationSql(scratch.url, target.sql);
      expect(await state(scratch.url)).toEqual([
        { n: 'PaymentAttempt_fulfilmentStatus_check', v: false },
        { n: 'PaymentAttempt_paymentState_check', v: false },
      ]);
      await applyMigrationSql(scratch.url, rollbackSql);
      expect(await state(scratch.url)).toEqual([]);
      expect(
        await rows(
          scratch.url,
          `SELECT column_name FROM information_schema.columns
            WHERE table_name = 'PaymentAttempt' AND column_name IN ('paymentState', 'fulfilmentStatus')`,
        ),
      ).toEqual([]);
    });

    it('takes no lock that blocks writes while validating (SHARE UPDATE EXCLUSIVE only)', () => {
      const code = validate.sql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
      expect(code).toMatch(
        /VALIDATE CONSTRAINT "PaymentAttempt_paymentState_check"/,
      );
      expect(code).toMatch(
        /VALIDATE CONSTRAINT "PaymentAttempt_fulfilmentStatus_check"/,
      );
      // Nothing that needs a stronger lock: no ADD COLUMN, ADD CONSTRAINT, UPDATE or DROP.
      expect(code).not.toMatch(/ADD COLUMN|ADD CONSTRAINT|UPDATE|DROP|DELETE/);
    });
  });

  describe('backfill cutoff is UTC-consistent under any session time zone', () => {
    // PaymentAttempt."updatedAt" is a TIMESTAMP WITHOUT TIME ZONE holding UTC.
    // These rows are aged in UTC; the migration runs in a session whose time
    // zone is set at the DATABASE level, so a bare now() would shift the cutoff
    // by the zone's offset (up to +14h / -12h).
    const AGES: Array<[string, string, boolean]> = [
      ['10min', '10 minutes', false],
      ['50min', '50 minutes', false],
      ['70min', '70 minutes', true],
      ['3h', '3 hours', true],
    ];
    const attempts = AGES.flatMap(([tag, age]) => {
      const at = `(now() AT TIME ZONE 'UTC') - interval '${age}'`;
      return [
        attempt(`tz-p-${tag}`, A, 'PENDING', at),
        attempt(`tz-s-${tag}`, A, 'SUCCEEDED', at),
      ];
    });
    const FIXTURES = [
      `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ('${A}', 'tenant-a', 'A', 'ACTIVE', now())`,
      ...attempts,
    ];

    it.each([
      'UTC',
      'Asia/Kolkata',
      'Pacific/Kiritimati',
      'America/Los_Angeles',
      'Etc/GMT+12',
    ])(
      'in a %s session, only attempts older than one hour (in UTC) are queued',
      async (zone) => {
        const scratch = await fresh('esp03_tz');
        await run(
          baseUrl,
          `ALTER DATABASE "${scratch.name}" SET timezone TO '${zone}'`,
        );
        await applyMigrations(scratch.url, beforeTarget);
        for (const statement of FIXTURES) await run(scratch.url, statement);
        expect(
          (await rows<{ TimeZone: string }>(scratch.url, 'SHOW timezone'))[0],
        ).toEqual({
          TimeZone: zone,
        });

        await applyMigrationSql(scratch.url, target.sql);

        const queued = await rows<{
          id: string;
          s: string | null;
          f: string | null;
        }>(
          scratch.url,
          `SELECT id, "paymentState" AS s, "fulfilmentStatus" AS f FROM "PaymentAttempt" ORDER BY id COLLATE "C"`,
        );
        const expected = AGES.flatMap(([tag, , old]) => [
          { id: `tz-p-${tag}`, s: old ? 'UNKNOWN' : null, f: null },
          {
            id: `tz-s-${tag}`,
            s: old ? 'SUCCEEDED' : null,
            f: old ? 'NEEDS_REVIEW' : null,
          },
        ]).sort((x, y) => (x.id < y.id ? -1 : 1));
        expect(queued).toEqual(expected);
        expect(await caseSnapshot(scratch.url)).toHaveLength(4);
        // Never a failure classification, whatever the zone.
        expect(
          queued.filter((r) => r.s === 'FAILED' || r.s === 'DECLINED'),
        ).toEqual([]);
        // The rows the migration itself writes are UTC too.
        const skew = await rows<{ s: number }>(
          scratch.url,
          `SELECT max(abs(extract(epoch FROM ((now() AT TIME ZONE 'UTC') - "createdAt"))))::float AS s
             FROM "PaymentReconciliationCase"`,
        );
        expect(skew[0].s).toBeLessThan(120);
      },
    );
  });

  describe('rollback and re-apply', () => {
    it('rolls back to exactly the legacy schema and re-applies to the same cases', async () => {
      const scratch = await fresh('esp03_rollback');
      await applyMigrations(scratch.url, beforeTarget);
      for (const statement of LEGACY_FIXTURES)
        await run(scratch.url, statement);
      const before = await legacySnapshot(scratch.url);

      await applyMigrationSql(scratch.url, target.sql);
      await applyMigrationSql(scratch.url, validate.sql);
      const firstCases = await caseSnapshot(scratch.url);
      expect(firstCases).toHaveLength(Object.keys(EXPECTED_CASES).length);

      await applyMigrationSql(scratch.url, rollbackSql);
      const left = await rows<{ n: string }>(
        scratch.url,
        `SELECT table_name AS n FROM information_schema.tables
          WHERE table_name LIKE 'PaymentReconciliation%'
         UNION ALL
         SELECT column_name FROM information_schema.columns
          WHERE table_name = 'PaymentAttempt' AND column_name IN ('paymentState', 'fulfilmentStatus')
         UNION ALL
         SELECT proname FROM pg_proc WHERE proname = 'reject_payment_reconciliation_event_change'`,
      );
      expect(left).toEqual([]);
      expect(await legacySnapshot(scratch.url)).toEqual(before);

      await applyMigrationSql(scratch.url, target.sql);
      expect(await caseSnapshot(scratch.url)).toEqual(firstCases);
    });

    it.each([
      [
        'a case was assigned',
        `UPDATE "PaymentReconciliationCase" SET "assigneeInternalUserId" = 'iu-a' WHERE "paymentAttemptId" = 'p-old'`,
      ],
      [
        'a case was progressed',
        `UPDATE "PaymentReconciliationCase" SET status = 'IN_REVIEW' WHERE "paymentAttemptId" = 'p-old'`,
      ],
      [
        'an event was recorded after the migration',
        `INSERT INTO "PaymentReconciliationEvent" (id, "caseId", "actorKind", action, "tenantId")
         SELECT 'late-event', id, 'SYSTEM', 'SWEPT', "tenantId" FROM "PaymentReconciliationCase" WHERE "paymentAttemptId" = 'p-old'`,
      ],
    ])(
      'refuses to roll back, changing nothing, once %s',
      async (_label, work) => {
        const scratch = await fresh('esp03_refuse');
        await applyMigrations(scratch.url, beforeTarget);
        for (const statement of LEGACY_FIXTURES)
          await run(scratch.url, statement);
        await applyMigrationSql(scratch.url, target.sql);
        await run(scratch.url, work);
        const cases = await caseSnapshot(scratch.url);
        const events = await rows(
          scratch.url,
          `SELECT id FROM "PaymentReconciliationEvent" ORDER BY id`,
        );

        await expect(
          applyMigrationSql(scratch.url, rollbackSql),
        ).rejects.toThrow(/rollback refused/);
        expect(await caseSnapshot(scratch.url)).toEqual(cases);
        expect(
          await rows(
            scratch.url,
            `SELECT id FROM "PaymentReconciliationEvent" ORDER BY id`,
          ),
        ).toEqual(events);
        expect(
          await rows(
            scratch.url,
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'PaymentAttempt' AND column_name = 'paymentState'`,
          ),
        ).toHaveLength(1);
      },
    );

    it('a second apply on an already migrated database aborts without changes', async () => {
      const cases = await caseSnapshot(populated.url);
      await expect(
        applyMigrationSql(populated.url, target.sql),
      ).rejects.toThrow(/already exists|already has/);
      expect(await caseSnapshot(populated.url)).toEqual(cases);
    });
  });
});
