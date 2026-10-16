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

// SC3c-3 — migration 20261029090000_billing_notifications, on scratch
// databases: applied over EXISTING data (nothing changed), the billing
// contact (same-business staff only, never moved), the append-only grace
// extensions, the billing notice queue (shape, never deleted, a finished
// notice final), the grace exception (UNPAID only), the verified-email
// stamps, and a rollback that restores the SC3c-2 shape when no SC3c-3 data
// exists and refuses, changing nothing, once it does.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261029090000_billing_notifications.down.sql',
);
const THIS = '20261029090000_billing_notifications';
const FOUNDING_VERSION = '01a0db02-f800-7000-8000-00000000f002';
const A = '01a0db02-f800-7000-8000-7e5700003d0a';
const B = '01a0db02-f800-7000-8000-7e5700003d0b';

jest.setTimeout(120_000);

describe('SC3c-3 billing notifications migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  let subscriptionId: string;
  let operatorId: string;
  const sql = <T>(fn: (client: Client) => Promise<T>) =>
    withScratchClient(scratch.url, fn);
  const query = (text: string, params: unknown[] = []) =>
    sql((c) => c.query<Record<string, unknown>>(text, params));
  const expectRefused = (statement: string, params: unknown[] = []) =>
    expect(query(statement, params)).rejects.toThrow();
  const notice = (over: Record<string, unknown> = {}) => {
    const row = {
      kind: 'PAYMENT_FAILED',
      dedupeKey: `k-${Math.random()}`,
      status: 'PENDING',
      attemptCount: 0,
      sendStartedAt: null,
      possibleDuplicate: false,
      sentAt: null,
      finishedAt: null,
      lastErrorCode: null,
      ...over,
    };
    return query(
      `INSERT INTO "BillingNotification"
         (id, "subscriptionId", kind, "dedupeKey", payload, status, "attemptCount", "expiresAt",
          "sendStartedAt", "possibleDuplicate", "sentAt", "finishedAt", "lastErrorCode")
       VALUES (gen_random_uuid()::text, $1, $2, $3, '{}'::jsonb, $4, $5, now() + interval '1 day',
               $6, $7, $8, $9, $10) RETURNING id`,
      [
        subscriptionId,
        row.kind,
        row.dedupeKey,
        row.status,
        row.attemptCount,
        row.sendStartedAt,
        row.possibleDuplicate,
        row.sentAt,
        row.finishedAt,
        row.lastErrorCode,
      ],
    );
  };

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3c3_migration',
    );
    const all = listMigrations(MIGRATIONS);
    const at = all.findIndex((migration) => migration.name === THIS);
    expect(at).toBeGreaterThan(0);
    // Data that exists BEFORE the migration.
    await applyMigrations(scratch.url, all.slice(0, at));
    await sql(async (c) => {
      for (const [id, slug] of [
        [A, 'sc3c3-a'],
        [B, 'sc3c3-b'],
      ]) {
        await c.query(
          `INSERT INTO "Tenant" (id, slug, name, status, "updatedAt") VALUES ($1, $2, $2, 'ACTIVE', now())`,
          [id, slug],
        );
        await c.query(
          `INSERT INTO "InternalUser" (id, "externalProvider", email, status, "updatedAt", "tenantId")
           VALUES ($1, 'internal-dev', $2, 'ACTIVE', now(), $3)`,
          [`iu-${slug}`, `${slug}@example.test`, id],
        );
      }
      subscriptionId = (
        await c.query<{ id: string }>(
          `INSERT INTO "TenantSubscription" (id, "subscriberTenantId", "planVersionId", "updatedAt")
           VALUES (gen_random_uuid()::text, $1, $2, now()) RETURNING id`,
          [A, FOUNDING_VERSION],
        )
      ).rows[0].id;
      operatorId = (
        await c.query<{ id: string }>(
          `INSERT INTO "PlatformOperator" (id, "externalProvider", "externalSubject", email, status, "updatedAt")
           VALUES (gen_random_uuid()::text, 'platform-dev', 'platform-dev:sc3c3-mig', 'op@example.test', 'ACTIVE', now())
           RETURNING id`,
        )
      ).rows[0].id;
    });
    const before = await query(
      `SELECT id, email, status FROM "InternalUser" ORDER BY id`,
    );
    await applyMigrations(scratch.url, [all[at]]);
    const after = await query(
      `SELECT id, email, status, "verifiedEmail", "emailVerifiedAt" FROM "InternalUser" ORDER BY id`,
    );
    expect(after.rows).toEqual(
      before.rows.map((row) => ({
        ...row,
        verifiedEmail: null,
        emailVerifiedAt: null,
      })),
    );
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('a verified-email stamp is lower-case and complete, never half-set', async () => {
    await expectRefused(
      `UPDATE "InternalUser" SET "verifiedEmail" = 'Mixed@Example.test', "emailVerifiedAt" = now() WHERE id = 'iu-sc3c3-a'`,
    );
    await expectRefused(
      `UPDATE "InternalUser" SET "verifiedEmail" = 'sc3c3-a@example.test' WHERE id = 'iu-sc3c3-a'`,
    );
    await query(
      `UPDATE "InternalUser" SET "verifiedEmail" = 'sc3c3-a@example.test', "emailVerifiedAt" = now() WHERE id = 'iu-sc3c3-a'`,
    );
  });

  it('the billing contact is one per business, of that business’s own staff, and never moves', async () => {
    await expectRefused(
      `INSERT INTO "TenantBillingContact" (id, "tenantId", "internalUserId", "updatedAt") VALUES ('c-x', $1, 'iu-sc3c3-b', now())`,
      [A],
    );
    await query(
      `INSERT INTO "TenantBillingContact" (id, "tenantId", "internalUserId", "updatedAt") VALUES ('c-a', $1, 'iu-sc3c3-a', now())`,
      [A],
    );
    await expectRefused(
      `INSERT INTO "TenantBillingContact" (id, "tenantId", "internalUserId", "updatedAt") VALUES ('c-a2', $1, 'iu-sc3c3-a', now())`,
      [A],
    );
    await expectRefused(
      `UPDATE "TenantBillingContact" SET "tenantId" = $1 WHERE id = 'c-a'`,
      [B],
    );
    // The staff member cannot be removed while they are the contact.
    await expectRefused(`DELETE FROM "InternalUser" WHERE id = 'iu-sc3c3-a'`);
  });

  it('a grace exception exists only on an UNPAID subscription', async () => {
    await expectRefused(
      `UPDATE "TenantSubscription" SET "graceExceptionEndsAt" = now() + interval '1 day' WHERE id = $1`,
      [subscriptionId],
    );
  });

  it('grace extensions are bounded, need a reason and are append-only', async () => {
    const insert = (days: number, reason: string, endsOffset = days) =>
      query(
        `INSERT INTO "BillingGraceExtension"
           (id, "subscriptionId", kind, "episodeStartedAt", days, "previousEndsAt", "newEndsAt", reason, "actorPlatformOperatorId")
         VALUES (gen_random_uuid()::text, $1, 'GRACE_EXTENDED', now(), $2, now(), now() + ($4 || ' days')::interval, $3, $5)
         RETURNING id`,
        [subscriptionId, days, reason, String(endsOffset), operatorId],
      );
    await expect(insert(15, 'A long enough reason')).rejects.toThrow();
    await expect(insert(0, 'A long enough reason')).rejects.toThrow();
    await expect(insert(5, 'short')).rejects.toThrow();
    await expect(insert(5, 'A long enough reason', -1)).rejects.toThrow();
    const id = String((await insert(5, 'A long enough reason')).rows[0].id);
    await expectRefused(
      `UPDATE "BillingGraceExtension" SET days = 1 WHERE id = $1`,
      [id],
    );
    await expectRefused(`DELETE FROM "BillingGraceExtension" WHERE id = $1`, [
      id,
    ]);
    await expectRefused(`TRUNCATE "BillingGraceExtension"`);
  });

  it('billing notices: a strict shape, deduplicated, never deleted, and final once finished', async () => {
    await expect(notice({ kind: 'SOMETHING' })).rejects.toThrow();
    await expect(notice({ attemptCount: 3 })).rejects.toThrow();
    await expect(
      notice({ status: 'SENT', finishedAt: new Date() }),
    ).rejects.toThrow();
    await expect(notice({ possibleDuplicate: true })).rejects.toThrow();
    await expect(notice({ lastErrorCode: 'lower case' })).rejects.toThrow();
    await notice({ dedupeKey: 'same' });
    await expect(notice({ dedupeKey: 'same' })).rejects.toThrow();
    const id = String((await notice()).rows[0].id);
    await expectRefused(`DELETE FROM "BillingNotification" WHERE id = $1`, [
      id,
    ]);
    await expectRefused(
      `UPDATE "BillingNotification" SET kind = 'GRACE_ENDING' WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingNotification" SET payload = '{"x":1}' WHERE id = $1`,
      [id],
    );
    await query(
      `UPDATE "BillingNotification" SET status = 'SENT', "sentAt" = now(), "finishedAt" = now(), "attemptCount" = 1, "sendStartedAt" = now() WHERE id = $1`,
      [id],
    );
    await expectRefused(
      `UPDATE "BillingNotification" SET "lastErrorCode" = 'LATER' WHERE id = $1`,
      [id],
    );
  });

  it('records the grace history types', async () => {
    for (const type of [
      'GRACE_EXTENDED',
      'GRACE_EXCEPTION_GRANTED',
      'GRACE_EXCEPTION_EXPIRED',
    ]) {
      await query(
        `INSERT INTO "TenantSubscriptionEvent" (id, "subscriptionId", type, source, "fromStatus", "toStatus")
         VALUES (gen_random_uuid()::text, $1, $2, 'OPERATOR', 'UNPAID', 'UNPAID')`,
        [subscriptionId, type],
      );
      await expectRefused(
        `INSERT INTO "TenantSubscriptionEvent" (id, "subscriptionId", type, source)
         VALUES (gen_random_uuid()::text, $1, $2, 'OPERATOR')`,
        [subscriptionId, type],
      );
    }
  });

  it('the rollback refuses, changing nothing, once SC3c-3 data exists', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    const counts = await query(
      `SELECT (SELECT count(*) FROM "TenantBillingContact")::int AS contacts,
              (SELECT count(*) FROM "BillingGraceExtension")::int AS extensions`,
    );
    expect(counts.rows[0]).toEqual({ contacts: 1, extensions: 1 });
  });

  it('the rollback restores the SC3c-2 shape when no SC3c-3 data exists', async () => {
    const clean = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3c3_rollback_clean',
    );
    try {
      await applyMigrations(clean.url, listMigrations(MIGRATIONS));
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      const tables = await withScratchClient(
        clean.url,
        async (c) =>
          (
            await c.query<{ name: string }>(
              `SELECT table_name AS name FROM information_schema.tables
              WHERE table_name IN ('TenantBillingContact', 'BillingGraceExtension', 'BillingNotification')`,
            )
          ).rows,
      );
      expect(tables).toEqual([]);
      const columns = await withScratchClient(
        clean.url,
        async (c) =>
          (
            await c.query<{ name: string }>(
              `SELECT column_name AS name FROM information_schema.columns
              WHERE (table_name = 'InternalUser' AND column_name IN ('verifiedEmail', 'emailVerifiedAt'))
                 OR (table_name = 'TenantSubscription' AND column_name = 'graceExceptionEndsAt')`,
            )
          ).rows,
      );
      expect(columns).toEqual([]);
      const values = await withScratchClient(clean.url, async (c) =>
        (
          await c.query<{ value: string }>(
            `SELECT unnest(enum_range(NULL::"TenantSubscriptionEventType"))::text AS value`,
          )
        ).rows.map((r) => r.value),
      );
      expect(values).not.toContain('GRACE_EXTENDED');
      expect(values).toContain('SUBSCRIPTION_REPLACED');
    } finally {
      await clean.drop();
    }
  });
});
