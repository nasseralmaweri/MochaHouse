import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import {
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';

// R1 / S4a — the additive notification reliability foundation:
// OutboxEvent retry / lease / failure columns, NotificationDelivery send-intent
// columns, their CHECKs and two partial indexes. Exercised through the REAL
// migration SQL (and its rollback) against scratch databases created and marked
// by the disposable-database guard, with no Prisma CLI spawn.

jest.setTimeout(300_000);

const databasePackage = join(__dirname, '../../../../packages/database');
const migrations = listMigrations(join(databasePackage, 'prisma/migrations'));
const targetIndex = migrations.findIndex((m) =>
  m.name.endsWith('_notification_reliability_foundation'),
);
const beforeTarget = migrations.slice(0, targetIndex);
const target = migrations[targetIndex];
const validate = migrations.find((m) =>
  m.name.endsWith('_notification_reliability_validate_checks'),
)!;
const rollbackSql = readFileSync(
  join(
    databasePackage,
    'prisma/rollbacks/20261018090000_notification_reliability_foundation.down.sql',
  ),
  'utf8',
);
const baseUrl = process.env.DATABASE_URL!;

const A = '01a0db02-f800-7000-8000-7e570000a001';
const B = '01a0db02-f800-7000-8000-7e570000b002';

const NEW_EVENT_COLUMNS = [
  'attemptCount',
  'nextAttemptAt',
  'lastAttemptAt',
  'leaseOwner',
  'leaseExpiresAt',
  'expiresAt',
  'lastErrorCode',
  'lastError',
  'failedAt',
];

// Rows as the application created them BEFORE this migration (none of the
// new columns exist yet). Includes the crash victims of the old flow.
const event = (id: string, tenant: string, status: string, extra = '') =>
  `INSERT INTO "OutboxEvent" (id, "aggregateType", "aggregateId", "eventType", payload, status, "processedAt", "tenantId"${extra ? ', ' + extra.split('|')[0] : ''})
   VALUES ('${id}', 'Order', 'ord-${id}', 'order.checkout.completed', '{}', '${status}',
           ${status === 'PENDING' ? 'NULL' : 'now()'}, '${tenant}'${extra ? ', ' + extra.split('|')[1] : ''})`;
const delivery = (
  id: string,
  eventId: string,
  tenant: string,
  status: string,
) =>
  `INSERT INTO "NotificationDelivery" (id, "outboxEventId", channel, recipient, "templateKey", status, "aggregateType", "aggregateId", "tenantId", "sentAt")
   VALUES ('${id}', '${eventId}', 'EMAIL', 'c@example.test', 'order.received', '${status}', 'Order', 'ord-${eventId}', '${tenant}',
           ${status === 'SENT' ? 'now()' : 'NULL'})`;

const LEGACY_FIXTURES = [
  `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ('${A}', 'tenant-a', 'A', 'ACTIVE', now()), ('${B}', 'tenant-b', 'B', 'ACTIVE', now())`,
  // handled, delivered
  event('e-sent', A, 'PROCESSED'),
  delivery('d-sent', 'e-sent', A, 'SENT'),
  // handled by the old flow but the send FAILED (never retried)
  event('e-failed-send', A, 'PROCESSED'),
  delivery('d-failed', 'e-failed-send', A, 'FAILED'),
  // crash victims of the old flow: PROCESSED with a PENDING delivery / no delivery
  event('e-crash-pending', A, 'PROCESSED'),
  delivery('d-crash', 'e-crash-pending', A, 'PENDING'),
  event('e-crash-none', B, 'PROCESSED'),
  // not yet claimed
  event('e-pending', A, 'PENDING'),
  event('e-pending-b', B, 'PENDING'),
];

interface ClaimRow {
  id: string;
  tenantId: string;
  attemptCount: number;
}
const asClaims = (result: { rows: unknown[] }) => result.rows as ClaimRow[];

async function run(url: string, sql: string) {
  return withScratchClient(url, (client) => client.query(sql));
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
const CHECK_VIOLATION = '23514';

const legacyEvents = (url: string) =>
  rows(
    url,
    `SELECT id, "aggregateType", "aggregateId", "eventType", payload, status::text AS status, "createdAt", "processedAt", "tenantId"
       FROM "OutboxEvent" ORDER BY id`,
  );
const legacyDeliveries = (url: string) =>
  rows(
    url,
    `SELECT id, "outboxEventId", status::text AS status, recipient, "failureReason", "providerMessageId", "sentAt", "tenantId"
       FROM "NotificationDelivery" ORDER BY id`,
  );

describe('R1 / S4a: notification reliability database foundation', () => {
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
  let eventsBefore: Awaited<ReturnType<typeof legacyEvents>>;
  let deliveriesBefore: Awaited<ReturnType<typeof legacyDeliveries>>;

  beforeAll(async () => {
    populated = await fresh('s4a_populated');
    await applyMigrations(populated.url, beforeTarget);
    for (const statement of LEGACY_FIXTURES)
      await run(populated.url, statement);
    eventsBefore = await legacyEvents(populated.url);
    deliveriesBefore = await legacyDeliveries(populated.url);
    await applyMigrationSql(populated.url, target.sql);
  });

  describe('schema', () => {
    it('adds the OutboxEvent columns with safe defaults', async () => {
      const columns = await rows<{
        c: string;
        n: string;
        d: string | null;
      }>(
        populated.url,
        `SELECT column_name AS c, is_nullable AS n, column_default AS d FROM information_schema.columns
          WHERE table_name = 'OutboxEvent' AND column_name IN (${NEW_EVENT_COLUMNS.map((c) => `'${c}'`).join(', ')}) ORDER BY 1`,
      );
      expect(columns.map((c) => c.c).sort()).toEqual(
        [...NEW_EVENT_COLUMNS].sort(),
      );
      const byName = Object.fromEntries(columns.map((c) => [c.c, c]));
      expect(byName.attemptCount).toMatchObject({ n: 'NO', d: '0' });
      expect(byName.nextAttemptAt.n).toBe('NO');
      expect(byName.nextAttemptAt.d).toContain("timezone('utc'");
      for (const nullable of [
        'lastAttemptAt',
        'leaseOwner',
        'leaseExpiresAt',
        'expiresAt',
        'lastErrorCode',
        'lastError',
        'failedAt',
      ]) {
        expect(byName[nullable]).toMatchObject({ n: 'YES', d: null });
      }
    });

    it('adds the delivery send-intent columns', async () => {
      const columns = await rows<{ c: string; n: string; d: string | null }>(
        populated.url,
        `SELECT column_name AS c, is_nullable AS n, column_default AS d FROM information_schema.columns
          WHERE table_name = 'NotificationDelivery' AND column_name IN ('sendStartedAt', 'possibleDuplicate') ORDER BY 1`,
      );
      expect(columns).toEqual([
        { c: 'possibleDuplicate', n: 'NO', d: 'false' },
        { c: 'sendStartedAt', n: 'YES', d: null },
      ]);
    });

    it('creates the two partial indexes with the right predicates', async () => {
      const indexes = await rows<{ name: string; def: string }>(
        populated.url,
        `SELECT indexname AS name, indexdef AS def FROM pg_indexes
          WHERE tablename = 'OutboxEvent' AND indexname IN ('OutboxEvent_pending_due_idx', 'OutboxEvent_failed_idx') ORDER BY 1`,
      );
      expect(indexes.map((i) => i.name)).toEqual([
        'OutboxEvent_failed_idx',
        'OutboxEvent_pending_due_idx',
      ]);
      expect(indexes[1].def).toMatch(/\("nextAttemptAt", "createdAt"\)/);
      expect(indexes[1].def).toMatch(/WHERE \(status = 'PENDING'/);
      expect(indexes[0].def).toMatch(/\("tenantId", "failedAt"\)/);
      expect(indexes[0].def).toMatch(/WHERE \(status = 'FAILED'/);
    });

    it('adds the CHECKs NOT VALID, and the follow-up migration validates them', async () => {
      const state = () =>
        rows<{ name: string; valid: boolean }>(
          populated.url,
          `SELECT conname AS name, convalidated AS valid FROM pg_constraint
            WHERE conname LIKE 'OutboxEvent\\_%\\_check' OR conname = 'NotificationDelivery_possibleDuplicate_check' ORDER BY 1`,
        );
      const before = await state();
      expect(before.length).toBeGreaterThanOrEqual(8);
      expect(before.every((c) => c.valid === false)).toBe(true);
      await applyMigrationSql(populated.url, validate.sql);
      const after = await state();
      expect(after.every((c) => c.valid)).toBe(true);
      // Idempotent: validating again is a no-op.
      await applyMigrationSql(populated.url, validate.sql);
    });

    it('stores the nextAttemptAt default in UTC whatever the session time zone', async () => {
      const scratch = await fresh('s4a_tz');
      await applyMigrations(scratch.url, migrations);
      await run(
        scratch.url,
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ('${A}', 'tenant-a', 'A', 'ACTIVE', now())`,
      );
      const skew = await withScratchClient(scratch.url, async (client) => {
        await client.query("SET TIME ZONE 'Pacific/Auckland'");
        await client.query(event('tz-1', A, 'PENDING'));
        const r = await client.query(
          `SELECT abs(extract(epoch FROM ("nextAttemptAt" - timezone('utc', now())))) AS skew FROM "OutboxEvent" WHERE id = 'tz-1'`,
        );
        return Number((r.rows[0] as { skew: string }).skew);
      });
      // A bare CURRENT_TIMESTAMP default would be ~12-13 hours off here.
      expect(skew).toBeLessThan(5);
    });

    it('a fresh database gets the same shape from the full migration history', async () => {
      const scratch = await fresh('s4a_fresh');
      await applyMigrations(scratch.url, migrations);
      const count = await rows<{ n: string }>(
        scratch.url,
        `SELECT count(*) AS n FROM information_schema.columns
          WHERE (table_name = 'OutboxEvent' AND column_name IN ('attemptCount','nextAttemptAt','leaseOwner','leaseExpiresAt','failedAt'))
             OR (table_name = 'NotificationDelivery' AND column_name IN ('sendStartedAt','possibleDuplicate'))`,
      );
      expect(Number(count[0].n)).toBe(7);
    });
  });

  describe('historical records', () => {
    it('changes no legacy column on any event or delivery', async () => {
      expect(await legacyEvents(populated.url)).toEqual(eventsBefore);
      expect(await legacyDeliveries(populated.url)).toEqual(deliveriesBefore);
    });

    it("leaves PROCESSED events (including the old flow's crash victims) PROCESSED, so nothing is re-sent", async () => {
      const processed = await rows<{ id: string; status: string }>(
        populated.url,
        `SELECT id, status::text AS status FROM "OutboxEvent" WHERE id LIKE 'e-%' AND status = 'PROCESSED' ORDER BY id`,
      );
      expect(processed.map((p) => p.id)).toEqual([
        'e-crash-none',
        'e-crash-pending',
        'e-failed-send',
        'e-sent',
      ]);
      // A worker that only claims PENDING rows can never reach them.
    });

    it('gives every historical row neutral new values: no attempts, lease, error, expiry or duplicate flag', async () => {
      const dirty = await rows(
        populated.url,
        `SELECT id FROM "OutboxEvent"
          WHERE "attemptCount" <> 0 OR "leaseOwner" IS NOT NULL OR "leaseExpiresAt" IS NOT NULL
             OR "lastAttemptAt" IS NOT NULL OR "expiresAt" IS NOT NULL OR "lastError" IS NOT NULL
             OR "lastErrorCode" IS NOT NULL OR "failedAt" IS NOT NULL OR "nextAttemptAt" IS NULL`,
      );
      expect(dirty).toEqual([]);
      const flagged = await rows(
        populated.url,
        `SELECT id FROM "NotificationDelivery" WHERE "sendStartedAt" IS NOT NULL OR "possibleDuplicate"`,
      );
      expect(flagged).toEqual([]);
    });

    it('applies no age cut-off: legacy PENDING events stay PENDING and unexpired', async () => {
      const pending = await rows<{ id: string; exp: unknown; tenant: string }>(
        populated.url,
        `SELECT id, "expiresAt" AS exp, "tenantId" AS tenant FROM "OutboxEvent" WHERE status = 'PENDING' ORDER BY id`,
      );
      expect(pending).toEqual([
        { id: 'e-pending', exp: null, tenant: A },
        { id: 'e-pending-b', exp: null, tenant: B },
      ]);
    });

    it('gives historical FAILED events a failedAt and nothing else', async () => {
      const scratch = await fresh('s4a_failed');
      await applyMigrations(scratch.url, beforeTarget);
      await run(
        scratch.url,
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ('${A}', 'tenant-a', 'A', 'ACTIVE', now())`,
      );
      await run(scratch.url, event('e-hist-failed', A, 'FAILED'));
      await run(
        scratch.url,
        event('e-hist-failed-nopt', A, 'FAILED').replace('now()', 'NULL'),
      );
      await applyMigrationSql(scratch.url, target.sql);
      await applyMigrationSql(scratch.url, validate.sql);
      const failed = await rows<{ id: string; ok: boolean }>(
        scratch.url,
        `SELECT id, "failedAt" IS NOT NULL AS ok FROM "OutboxEvent" ORDER BY id`,
      );
      expect(failed).toEqual([
        { id: 'e-hist-failed', ok: true },
        { id: 'e-hist-failed-nopt', ok: true },
      ]);
    });
  });

  describe('constraints', () => {
    let db: ScratchDatabase;
    beforeAll(async () => {
      db = await fresh('s4a_checks');
      await applyMigrations(db.url, migrations);
      await run(
        db.url,
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ('${A}', 'tenant-a', 'A', 'ACTIVE', now())`,
      );
      await run(db.url, event('c-base', A, 'PENDING'));
      await run(db.url, event('c-done', A, 'PROCESSED'));
      await run(db.url, delivery('cd-base', 'c-base', A, 'PENDING'));
    });

    const update = (id: string, set: string) =>
      sqlState(db.url, `UPDATE "OutboxEvent" SET ${set} WHERE id = '${id}'`);

    it.each([
      ['a negative attempt count', 'c-base', `"attemptCount" = -1`],
      ['a lease owner without an expiry', 'c-base', `"leaseOwner" = 'w1'`],
      [
        'a lease expiry without an owner',
        'c-base',
        `"leaseExpiresAt" = timezone('utc', now())`,
      ],
      [
        'a lease on a PROCESSED event',
        'c-done',
        `"leaseOwner" = 'w1', "leaseExpiresAt" = timezone('utc', now())`,
      ],
      [
        'a blank lease owner',
        'c-base',
        `"leaseOwner" = '', "leaseExpiresAt" = timezone('utc', now())`,
      ],
      [
        'an over-long lease owner',
        'c-base',
        `"leaseOwner" = repeat('w', 201), "leaseExpiresAt" = timezone('utc', now())`,
      ],
      [
        'a dead letter that still holds a lease',
        'c-base',
        `status = 'FAILED', "failedAt" = timezone('utc', now()), "leaseOwner" = 'w1', "leaseExpiresAt" = timezone('utc', now())`,
      ],
      ['FAILED without failedAt', 'c-base', `status = 'FAILED'`],
      [
        'failedAt on a non-FAILED event',
        'c-base',
        `"failedAt" = timezone('utc', now())`,
      ],
      ['an over-long lastError', 'c-base', `"lastError" = repeat('x', 2001)`],
      ['a malformed lastErrorCode', 'c-base', `"lastErrorCode" = 'not upper'`],
      [
        'an expiry before creation',
        'c-base',
        `"expiresAt" = "createdAt" - interval '1 second'`,
      ],
    ])('rejects %s', async (_label, id, set) => {
      expect(await update(id, set)).toBe(CHECK_VIOLATION);
    });

    it('accepts an immediate expiry (expiresAt equal to createdAt)', async () => {
      await run(db.url, event('c-eq', A, 'PENDING'));
      expect(await update('c-eq', `"expiresAt" = "createdAt"`)).toBeNull();
    });

    it('rejects possibleDuplicate without a send start', async () => {
      expect(
        await sqlState(
          db.url,
          `UPDATE "NotificationDelivery" SET "possibleDuplicate" = true WHERE id = 'cd-base'`,
        ),
      ).toBe(CHECK_VIOLATION);
      expect(
        await sqlState(
          db.url,
          `UPDATE "NotificationDelivery" SET "possibleDuplicate" = true, "sendStartedAt" = timezone('utc', now()) WHERE id = 'cd-base'`,
        ),
      ).toBeNull();
    });

    it('accepts the complete lifecycle the worker will use', async () => {
      const id = 'c-life';
      await run(db.url, event(id, A, 'PENDING'));
      // claim
      expect(
        await update(
          id,
          `"leaseOwner" = 'w1', "leaseExpiresAt" = timezone('utc', now()) + interval '60 seconds', "attemptCount" = "attemptCount" + 1, "lastAttemptAt" = timezone('utc', now())`,
        ),
      ).toBeNull();
      // retry: lease released, error recorded, rescheduled
      expect(
        await update(
          id,
          `"leaseOwner" = NULL, "leaseExpiresAt" = NULL, "lastErrorCode" = 'PROVIDER_THROTTLED', "lastError" = 'slow down', "nextAttemptAt" = timezone('utc', now()) + interval '30 seconds'`,
        ),
      ).toBeNull();
      // dead letter
      expect(
        await update(
          id,
          `status = 'FAILED', "failedAt" = timezone('utc', now()), "lastErrorCode" = 'RETRIES_EXHAUSTED'`,
        ),
      ).toBeNull();
      // success path on another event
      await run(db.url, event('c-ok', A, 'PENDING'));
      expect(
        await update(
          'c-ok',
          `"leaseOwner" = 'w1', "leaseExpiresAt" = timezone('utc', now()) + interval '60 seconds'`,
        ),
      ).toBeNull();
      expect(
        await update(
          'c-ok',
          `status = 'PROCESSED', "processedAt" = timezone('utc', now()), "leaseOwner" = NULL, "leaseExpiresAt" = NULL`,
        ),
      ).toBeNull();
    });

    it('accepts a unique per-claim lease token as the owner', async () => {
      await run(db.url, event('c-token', A, 'PENDING'));
      expect(
        await update(
          'c-token',
          `"leaseOwner" = 'host-1:4242:01a0db02-f800-7000-8000-7e570000c003', "leaseExpiresAt" = timezone('utc', now()) + interval '60 seconds'`,
        ),
      ).toBeNull();
    });

    it('keeps the tenant immutable on OutboxEvent', async () => {
      await run(
        db.url,
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ('${B}', 'tenant-b', 'B', 'ACTIVE', now())`,
      );
      expect(await update('c-base', `"tenantId" = '${B}'`)).not.toBeNull();
    });
  });

  describe('compatibility with the live (legacy) application', () => {
    it('lets the unchanged worker and API keep writing exactly as before', async () => {
      const db = await fresh('s4a_legacy');
      await applyMigrations(db.url, migrations);
      await run(
        db.url,
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ('${A}', 'tenant-a', 'A', 'ACTIVE', now())`,
      );
      // API producer: INSERT without any new column.
      await run(db.url, event('l-1', A, 'PENDING'));
      // legacy worker claim: the conditional UPDATE it uses today.
      const claimed = await run(
        db.url,
        `UPDATE "OutboxEvent" SET status = 'PROCESSED', "processedAt" = now() WHERE id = 'l-1' AND status = 'PENDING'`,
      );
      expect(claimed.rowCount).toBe(1);
      // legacy dispatch: insert the delivery, then mark SENT / FAILED.
      await run(db.url, delivery('l-d', 'l-1', A, 'PENDING'));
      expect(
        await sqlState(
          db.url,
          `UPDATE "NotificationDelivery" SET status = 'SENT', "sentAt" = now(), "providerMessageId" = 'm1' WHERE id = 'l-d'`,
        ),
      ).toBeNull();
    });

    it('fails closed (instead of double-sending) if a legacy worker tries to take a leased event', async () => {
      const db = await fresh('s4a_mixed');
      await applyMigrations(db.url, migrations);
      await run(
        db.url,
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ('${A}', 'tenant-a', 'A', 'ACTIVE', now())`,
      );
      await run(db.url, event('m-1', A, 'PENDING'));
      await run(
        db.url,
        `UPDATE "OutboxEvent" SET "leaseOwner" = 'new-worker', "leaseExpiresAt" = timezone('utc', now()) + interval '60 seconds' WHERE id = 'm-1'`,
      );
      expect(
        await sqlState(
          db.url,
          `UPDATE "OutboxEvent" SET status = 'PROCESSED', "processedAt" = now() WHERE id = 'm-1' AND status = 'PENDING'`,
        ),
      ).toBe(CHECK_VIOLATION);
    });
  });

  describe('mixed fleet (documented limitation, enforced by deployment order)', () => {
    it('does NOT stop a legacy worker consuming an event that is only waiting out a retry backoff', async () => {
      const db = await fresh('s4a_backoff');
      await applyMigrations(db.url, migrations);
      await run(
        db.url,
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ('${A}', 'tenant-a', 'A', 'ACTIVE', now())`,
      );
      await run(db.url, event('bo-1', A, 'PENDING'));
      await run(
        db.url,
        `UPDATE "OutboxEvent" SET "attemptCount" = 1, "nextAttemptAt" = timezone('utc', now()) + interval '1 hour' WHERE id = 'bo-1'`,
      );
      // The legacy claim ignores nextAttemptAt and succeeds: no constraint can
      // protect a backed-off row. This is why S4b must stop legacy workers
      // before it starts claiming (see the migration header and the PR notes).
      const consumed = await run(
        db.url,
        `UPDATE "OutboxEvent" SET status = 'PROCESSED', "processedAt" = now() WHERE id = 'bo-1' AND status = 'PENDING'`,
      );
      expect(consumed.rowCount).toBe(1);
    });
  });

  describe('suitable for lease fencing and concurrent workers (S4b)', () => {
    const CLAIM = `
      UPDATE "OutboxEvent" SET "leaseOwner" = $1,
             "leaseExpiresAt" = timezone('utc', now()) + interval '60 seconds',
             "attemptCount" = "attemptCount" + 1,
             "lastAttemptAt" = timezone('utc', now())
       WHERE id IN (
         SELECT id FROM "OutboxEvent"
          WHERE status = 'PENDING' AND "nextAttemptAt" <= timezone('utc', now())
            AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < timezone('utc', now()))
          ORDER BY "nextAttemptAt", "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, "tenantId", "attemptCount"`;

    let db: ScratchDatabase;
    beforeEach(async () => {
      db = await fresh('s4a_claim');
      await applyMigrations(db.url, migrations);
      await run(
        db.url,
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ('${A}', 'tenant-a', 'A', 'ACTIVE', now()), ('${B}', 'tenant-b', 'B', 'ACTIVE', now())`,
      );
    });

    it('SKIP LOCKED hands two simultaneous workers different events', async () => {
      await run(db.url, event('k-1', A, 'PENDING'));
      await run(db.url, event('k-2', B, 'PENDING'));
      const c1 = new Client({ connectionString: db.url });
      const c2 = new Client({ connectionString: db.url });
      await c1.connect();
      await c2.connect();
      try {
        // Open transactions hold the row locks while the other claims.
        await c1.query('BEGIN');
        await c2.query('BEGIN');
        const r1 = await c1.query(CLAIM, ['w1']);
        const r2 = await c2.query(CLAIM, ['w2']);
        await c1.query('COMMIT');
        await c2.query('COMMIT');
        const ids = [asClaims(r1)[0].id, asClaims(r2)[0].id].sort();
        expect(ids).toEqual(['k-1', 'k-2']);
        // The claim returns the event's own tenant for the worker context.
        expect(asClaims(r1)[0].tenantId).toBe(
          asClaims(r1)[0].id === 'k-1' ? A : B,
        );
        // A third claim finds nothing: both are leased.
        expect((await run(db.url, CLAIM.replace('$1', `'w3'`))).rows).toEqual(
          [],
        );
      } finally {
        await c1.end();
        await c2.end();
      }
    });

    it('is concurrency-safe at scale: many workers, each event claimed once', async () => {
      for (let i = 0; i < 20; i += 1)
        await run(db.url, event(`s-${i}`, i % 2 ? A : B, 'PENDING'));
      const clients = await Promise.all(
        Array.from({ length: 6 }, async () => {
          const c = new Client({ connectionString: db.url });
          await c.connect();
          return c;
        }),
      );
      try {
        const claimed: string[] = [];
        await Promise.all(
          clients.map(async (c, w) => {
            for (;;) {
              const r = await c.query(CLAIM, [`w${w}`]);
              if (r.rowCount === 0) return;
              claimed.push(asClaims(r)[0].id);
            }
          }),
        );
        expect(claimed).toHaveLength(20);
        expect(new Set(claimed).size).toBe(20);
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    });

    it('recovers an expired lease with a higher attempt count, and fences the stale owner', async () => {
      await run(db.url, event('r-1', A, 'PENDING'));
      const first = await run(db.url, CLAIM.replace('$1', `'dead-worker'`));
      expect(asClaims(first)[0].attemptCount).toBe(1);
      // While leased nobody else can take it.
      expect((await run(db.url, CLAIM.replace('$1', `'w2'`))).rows).toEqual([]);
      // The worker dies: its lease lapses.
      await run(
        db.url,
        `UPDATE "OutboxEvent" SET "leaseExpiresAt" = timezone('utc', now()) - interval '1 second' WHERE id = 'r-1'`,
      );
      const second = await run(db.url, CLAIM.replace('$1', `'w2'`));
      expect(asClaims(second)[0]).toMatchObject({ id: 'r-1', attemptCount: 2 });
      // The stale owner's late write is fenced out; the live owner's succeeds.
      const fenced = (owner: string) =>
        run(
          db.url,
          `UPDATE "OutboxEvent" SET status = 'PROCESSED', "processedAt" = timezone('utc', now()), "leaseOwner" = NULL, "leaseExpiresAt" = NULL
            WHERE id = 'r-1' AND "tenantId" = '${A}' AND "leaseOwner" = '${owner}' AND status = 'PENDING'`,
        );
      expect((await fenced('dead-worker')).rowCount).toBe(0);
      expect((await fenced('w2')).rowCount).toBe(1);
    });

    it('fences a stale run even when the SAME worker id re-claims the event (attemptCount in the fence)', async () => {
      await run(db.url, event('same-1', A, 'PENDING'));
      const first = await run(db.url, CLAIM.replace('$1', `'host-1'`));
      const staleAttempt = asClaims(first)[0].attemptCount; // 1
      await run(
        db.url,
        `UPDATE "OutboxEvent" SET "leaseExpiresAt" = timezone('utc', now()) - interval '1 second' WHERE id = 'same-1'`,
      );
      const second = await run(db.url, CLAIM.replace('$1', `'host-1'`));
      expect(asClaims(second)[0].attemptCount).toBe(staleAttempt + 1);
      const finish = (attempt: number) =>
        run(
          db.url,
          `UPDATE "OutboxEvent" SET status = 'PROCESSED', "processedAt" = timezone('utc', now()), "leaseOwner" = NULL, "leaseExpiresAt" = NULL
            WHERE id = 'same-1' AND "tenantId" = '${A}' AND "leaseOwner" = 'host-1' AND "attemptCount" = ${attempt} AND status = 'PENDING'`,
        );
      // Owner name alone would let the stale first run commit; the attempt does not.
      expect((await finish(staleAttempt)).rowCount).toBe(0);
      expect((await finish(staleAttempt + 1)).rowCount).toBe(1);
    });

    it('honours nextAttemptAt (backoff) and never claims PROCESSED or FAILED rows', async () => {
      await run(db.url, event('b-later', A, 'PENDING'));
      await run(
        db.url,
        `UPDATE "OutboxEvent" SET "nextAttemptAt" = timezone('utc', now()) + interval '1 hour' WHERE id = 'b-later'`,
      );
      await run(db.url, event('b-done', A, 'PROCESSED'));
      await run(db.url, event('b-dead', A, 'FAILED', `"failedAt"|now()`));
      expect((await run(db.url, CLAIM.replace('$1', `'w'`))).rows).toEqual([]);
    });

    it('uses the partial index for the claim scan', async () => {
      for (let i = 0; i < 200; i += 1)
        await run(
          db.url,
          event(`i-${i}`, A, i < 190 ? 'PROCESSED' : 'PENDING'),
        );
      await run(db.url, 'ANALYZE "OutboxEvent"');
      const plan = await withScratchClient(db.url, async (client) => {
        await client.query('SET enable_seqscan = off');
        const r = await client.query(
          `EXPLAIN SELECT id FROM "OutboxEvent"
            WHERE status = 'PENDING' AND "nextAttemptAt" <= timezone('utc', now())
            ORDER BY "nextAttemptAt", "createdAt" LIMIT 1`,
        );
        return (r.rows as Array<Record<string, string>>)
          .map((x) => x['QUERY PLAN'])
          .join('\n');
      });
      expect(plan).toContain('OutboxEvent_pending_due_idx');
    });
  });

  describe('migration safety and rollback', () => {
    it('aborts with nothing changed when a target column already exists', async () => {
      const db = await fresh('s4a_abort');
      await applyMigrations(db.url, beforeTarget);
      await run(
        db.url,
        `ALTER TABLE "OutboxEvent" ADD COLUMN "failedAt" TIMESTAMP(3)`,
      );
      await expect(applyMigrationSql(db.url, target.sql)).rejects.toThrow(
        /already exists/,
      );
      const added = await rows(
        db.url,
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'OutboxEvent' AND column_name IN ('attemptCount', 'leaseOwner', 'nextAttemptAt')`,
      );
      expect(added).toEqual([]);
    });

    it('rolls back cleanly on an untouched foundation and leaves history intact; re-applying works', async () => {
      const db = await fresh('s4a_rollback');
      await applyMigrations(db.url, beforeTarget);
      for (const statement of LEGACY_FIXTURES) await run(db.url, statement);
      const before = await legacyEvents(db.url);
      const deliveriesBefore2 = await legacyDeliveries(db.url);
      await applyMigrationSql(db.url, target.sql);
      await applyMigrationSql(db.url, validate.sql);
      await applyMigrationSql(db.url, rollbackSql);
      const gone = await rows(
        db.url,
        `SELECT column_name FROM information_schema.columns
          WHERE (table_name = 'OutboxEvent' AND column_name = ANY('{${NEW_EVENT_COLUMNS.join(',')}}'::text[]))
             OR (table_name = 'NotificationDelivery' AND column_name IN ('sendStartedAt','possibleDuplicate'))`,
      );
      expect(gone).toEqual([]);
      const leftovers = await rows(
        db.url,
        `SELECT 1 FROM pg_constraint WHERE conname LIKE 'OutboxEvent\\_%\\_check' AND conname NOT IN ('OutboxEvent_pkey')
         UNION ALL SELECT 1 FROM pg_indexes WHERE indexname IN ('OutboxEvent_pending_due_idx','OutboxEvent_failed_idx')`,
      );
      expect(leftovers).toEqual([]);
      expect(await legacyEvents(db.url)).toEqual(before);
      expect(await legacyDeliveries(db.url)).toEqual(deliveriesBefore2);
      await applyMigrationSql(db.url, target.sql); // re-applies
    });

    it('the validate migration fails cleanly (nothing changed) when the foundation is incomplete', async () => {
      const db = await fresh('s4a_novalidate');
      await applyMigrations(db.url, beforeTarget);
      await expect(applyMigrationSql(db.url, validate.sql)).rejects.toThrow();
      await applyMigrationSql(db.url, target.sql);
      await run(
        db.url,
        `ALTER TABLE "OutboxEvent" DROP CONSTRAINT "OutboxEvent_leaseOwner_check"`,
      );
      await expect(applyMigrationSql(db.url, validate.sql)).rejects.toThrow(
        /requires the foundation migration/,
      );
      const still = await rows<{ valid: boolean }>(
        db.url,
        `SELECT convalidated AS valid FROM pg_constraint WHERE conname = 'OutboxEvent_attemptCount_check'`,
      );
      expect(still).toEqual([{ valid: false }]);
    });

    it('rolls back when the validate migration never ran (constraints still NOT VALID)', async () => {
      const db = await fresh('s4a_rb_novalid');
      await applyMigrations(db.url, beforeTarget);
      await applyMigrationSql(db.url, target.sql);
      await applyMigrationSql(db.url, rollbackSql);
      const left = await rows(
        db.url,
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'OutboxEvent' AND column_name IN ('attemptCount','leaseOwner')`,
      );
      expect(left).toEqual([]);
    });

    it('refuses to roll back over recorded reliability data', async () => {
      const db = await fresh('s4a_refuse');
      await applyMigrations(db.url, migrations);
      await run(
        db.url,
        `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ('${A}', 'tenant-a', 'A', 'ACTIVE', now())`,
      );
      await run(db.url, event('x-1', A, 'PENDING'));
      await run(
        db.url,
        `UPDATE "OutboxEvent" SET "attemptCount" = 2, "lastError" = 'boom' WHERE id = 'x-1'`,
      );
      await expect(applyMigrationSql(db.url, rollbackSql)).rejects.toThrow(
        /rollback refused/,
      );
      // Nothing was dropped.
      const still = await rows(
        db.url,
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'OutboxEvent' AND column_name = 'attemptCount'`,
      );
      expect(still).toHaveLength(1);
    });
  });
});
