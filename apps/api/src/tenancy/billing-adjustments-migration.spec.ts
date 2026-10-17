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

// SC3e-3 — migration 20261103090000_billing_adjustments, on scratch
// databases: how a permission was granted is recorded and never changes; a
// financial permission is never a plain CLI grant; a console grant names its
// grantor, never the holder; and a rollback that refuses while any
// adjustment record or financial grant exists, and otherwise restores the
// SC3e-2 shape exactly.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261103090000_billing_adjustments.down.sql',
);

jest.setTimeout(120_000);

describe('SC3e-3 billing adjustments migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  let holder: string;
  let grantor: string;
  const sql = <T>(fn: (client: Client) => Promise<T>) =>
    withScratchClient(scratch.url, fn);
  const query = (text: string, params: unknown[] = []) =>
    sql((c) => c.query<Record<string, unknown>>(text, params));
  const operator = async (url: string, email: string) =>
    withScratchClient(url, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO "PlatformOperator" (id, "externalProvider", "externalSubject", email, status, "updatedAt")
         VALUES (gen_random_uuid()::text, 'platform-dev', $1, $2, 'ACTIVE', now()) RETURNING id`,
        [`platform-dev:${email}`, email],
      );
      return rows[0].id;
    });
  const grant = (
    operatorId: string,
    permission: string,
    over: Record<string, string | null> = {},
  ) => {
    const row: Record<string, string | null> = {
      grantedVia: 'CLI',
      grantedByOperatorId: null,
      approvalReference: null,
      executedBy: null,
      ...over,
    };
    return query(
      `INSERT INTO "PlatformOperatorPermission"
         (id, "operatorId", permission, "grantReason", "grantedVia", "grantedByOperatorId", "approvalReference", "executedBy")
       VALUES (gen_random_uuid()::text, $1, $2, 'Granted for the migration test.', $3, $4, $5, $6) RETURNING id`,
      [
        operatorId,
        permission,
        row.grantedVia,
        row.grantedByOperatorId,
        row.approvalReference,
        row.executedBy,
      ],
    );
  };

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3e3_migration',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    holder = await operator(scratch.url, 'holder@example.test');
    grantor = await operator(scratch.url, 'grantor@example.test');
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('records how each permission was granted; financial ones never by the plain CLI', async () => {
    await grant(holder, 'billing.cases.manage');
    for (const permission of [
      'billing.adjustments.request',
      'billing.adjustments.approve',
      'platform.permissions.manage',
    ]) {
      await expect(grant(holder, permission)).rejects.toThrow();
    }
    // A bootstrap names its approval and who ran it.
    await expect(
      grant(holder, 'billing.adjustments.approve', {
        grantedVia: 'CLI_BOOTSTRAP',
      }),
    ).rejects.toThrow();
    await grant(holder, 'billing.adjustments.approve', {
      grantedVia: 'CLI_BOOTSTRAP',
      approvalReference: 'CHG-1',
      executedBy: 'ops@host',
    });
    // A console grant names its grantor, never the holder.
    await expect(
      grant(holder, 'billing.adjustments.request', { grantedVia: 'CONSOLE' }),
    ).rejects.toThrow();
    await expect(
      grant(holder, 'billing.adjustments.request', {
        grantedVia: 'CONSOLE',
        grantedByOperatorId: holder,
      }),
    ).rejects.toThrow();
    const { rows } = await grant(holder, 'billing.adjustments.request', {
      grantedVia: 'CONSOLE',
      grantedByOperatorId: grantor,
    });
    // How it was granted never changes.
    for (const change of [
      `"grantedVia" = 'CLI'`,
      `"grantedByOperatorId" = NULL`,
      `"approvalReference" = 'OTHER'`,
    ]) {
      await expect(
        query(
          `UPDATE "PlatformOperatorPermission" SET ${change} WHERE id = $1`,
          [rows[0].id],
        ),
      ).rejects.toThrow();
    }
    // Revoked by a named operator.
    await query(
      `UPDATE "PlatformOperatorPermission" SET "revokedAt" = now(), "revokeReason" = 'Left the billing team.', "revokedByOperatorId" = $2 WHERE id = $1`,
      [rows[0].id, grantor],
    );
  });

  it('the rollback refuses, changing nothing, while a financial grant exists', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    expect(
      (
        await query(
          `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'BillingAdjustment'`,
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('the rollback restores the SC3e-2 shape exactly when nothing financial exists', async () => {
    const clean = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3e3_rollback_clean',
    );
    try {
      await applyMigrations(clean.url, listMigrations(MIGRATIONS));
      const id = await operator(clean.url, 'plain@example.test');
      await withScratchClient(clean.url, (c) =>
        c.query(
          `INSERT INTO "PlatformOperatorPermission" (id, "operatorId", permission, "grantReason")
           VALUES (gen_random_uuid()::text, $1, 'billing.cases.manage', 'Granted before the rollback.')`,
          [id],
        ),
      );
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      const left = await withScratchClient(clean.url, async (c) => ({
        objects: (
          await c.query<{ name: string }>(
            `SELECT table_name AS name FROM information_schema.tables
             WHERE table_name IN ('BillingAdjustment', 'BillingAdjustmentDecision', 'BillingAdjustmentEvent')
             UNION ALL
             SELECT column_name FROM information_schema.columns
             WHERE table_name = 'PlatformOperatorPermission'
               AND column_name IN ('grantedVia', 'grantedByOperatorId', 'approvalReference', 'executedBy', 'revokedByOperatorId')
             UNION ALL
             SELECT proname FROM pg_proc WHERE proname IN
               ('guard_billing_adjustment', 'guard_billing_adjustment_decision', 'guard_billing_adjustment_event')`,
          )
        ).rows,
        grants: (
          await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM "PlatformOperatorPermission"`,
          )
        ).rows[0].n,
      }));
      expect(left).toEqual({ objects: [], grants: 1 });
      // The SC3e-2 permission list again: the new permissions are unknown.
      await expect(
        withScratchClient(clean.url, (c) =>
          c.query(
            `INSERT INTO "PlatformOperatorPermission" (id, "operatorId", permission, "grantReason")
             VALUES (gen_random_uuid()::text, $1, 'billing.adjustments.request', 'After the rollback.')`,
            [id],
          ),
        ),
      ).rejects.toThrow();
    } finally {
      await clean.drop();
    }
  });
});
