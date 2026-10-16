import 'dotenv/config';
import { randomUUID } from 'node:crypto';
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

// SC1d — migration 20261023090000_tenant_provisioning_foundation, on a
// scratch database: additive only; the audit target fields are both-or-
// neither and machine values only; the provisioning record's keys are
// unique and format-checked; it is append-only; and the documented rollback
// restores the previous shape — but refuses while provisioning data exists.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261023090000_tenant_provisioning_foundation.down.sql',
);
const THIS = '20261023090000_tenant_provisioning_foundation';

describe('SC1d tenant provisioning foundation migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  const sql = <T>(fn: (client: Client) => Promise<T>) =>
    withScratchClient(scratch.url, fn);
  let operatorId: string;

  const columnsOf = (table: string) =>
    sql(async (c) =>
      (
        await c.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`,
          [table],
        )
      ).rows.map((r) => r.column_name),
    );
  const audit = (target: [string | null, string | null]) =>
    sql((c) =>
      c.query(
        `INSERT INTO "PlatformAuditEvent" (id, action, outcome, "targetType", "targetId")
         VALUES ($1, 'platform.tenant.provisioned', 'SUCCEEDED', $2, $3)`,
        [randomUUID(), ...target],
      ),
    );
  const operation = (row: Partial<Record<string, string>>) =>
    sql((c) =>
      c.query(
        `INSERT INTO "TenantProvisioningOperation"
           (id, "idempotencyKey", "requestHash", "provisionedTenantId", "actorPlatformOperatorId")
         VALUES ($1, $2, $3, $4, $5)`,
        [
          randomUUID(),
          row.idempotencyKey ?? randomUUID(),
          row.requestHash ?? 'a'.repeat(64),
          row.provisionedTenantId ?? randomUUID(),
          row.actor ?? operatorId,
        ],
      ),
    );

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc1d_migration',
    );
    // Up to (not including) this migration, then exactly this one. (Later
    // migrations, e.g. SC2a's, are irrelevant to what it adds.)
    const all = listMigrations(MIGRATIONS);
    const at = all.findIndex((migration) => migration.name === THIS);
    expect(at).toBeGreaterThan(0);
    await applyMigrations(scratch.url, all.slice(0, at));
    expect(await columnsOf('TenantProvisioningOperation')).toEqual([]);
    await applyMigrations(scratch.url, [all[at]]);
    operatorId = randomUUID();
    await sql((c) =>
      c.query(
        `INSERT INTO "PlatformOperator" (id, "externalProvider", "externalSubject", email, status, "updatedAt")
         VALUES ($1, 'platform-dev', 'platform-dev:sc1d-migration', 'sc1d-migration@example.test', 'ACTIVE', now())`,
        [operatorId],
      ),
    );
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('adds the audit target columns and the provisioning table — nothing else', async () => {
    expect(await columnsOf('PlatformAuditEvent')).toEqual(
      expect.arrayContaining(['targetId', 'targetType']),
    );
    expect(await columnsOf('TenantProvisioningOperation')).toEqual([
      'actorPlatformOperatorId',
      'createdAt',
      'id',
      'idempotencyKey',
      'provisionedTenantId',
      'requestHash',
    ]);
    // Platform-plane: no tenantId column, no foreign key to a business.
    const foreignTargets = await sql(async (c) =>
      (
        await c.query<{ target: string }>(
          `SELECT confrelid::regclass::text AS target FROM pg_constraint
            WHERE conrelid = '"TenantProvisioningOperation"'::regclass AND contype = 'f'`,
        )
      ).rows.map((r) => r.target),
    );
    expect(foreignTargets).toEqual(['"PlatformOperator"']);
  });

  it('audit targets are both-or-neither, and machine values only', async () => {
    await audit([null, null]);
    await audit(['tenant', randomUUID()]);
    for (const target of [
      ['tenant', null],
      [null, randomUUID()],
      ['Tenant', randomUUID()],
      ['tenant', 'not-a-uuid'],
      ['tenant', randomUUID().toUpperCase()],
    ] as const) {
      await expect(audit([target[0], target[1]])).rejects.toThrow(
        /PlatformAuditEvent_target_check/,
      );
    }
  });

  it('provisioning records: format-checked, one per key and one per business', async () => {
    const key = randomUUID();
    const tenant = randomUUID();
    await operation({ idempotencyKey: key, provisionedTenantId: tenant });
    await expect(operation({ idempotencyKey: key })).rejects.toThrow(
      /idempotencyKey_key/,
    );
    await expect(operation({ provisionedTenantId: tenant })).rejects.toThrow(
      /provisionedTenantId_key/,
    );
    await expect(operation({ idempotencyKey: 'KEY' })).rejects.toThrow(
      /idempotencyKey_check/,
    );
    await expect(operation({ requestHash: 'abc' })).rejects.toThrow(
      /requestHash_check/,
    );
    await expect(operation({ provisionedTenantId: 'x' })).rejects.toThrow(
      /provisionedTenantId_check/,
    );
    await expect(operation({ actor: randomUUID() })).rejects.toThrow(
      /actorPlatformOperatorId_fkey/,
    );
  });

  it('provisioning records are append-only (no UPDATE, DELETE or TRUNCATE)', async () => {
    for (const statement of [
      `UPDATE "TenantProvisioningOperation" SET "requestHash" = '${'b'.repeat(64)}'`,
      `DELETE FROM "TenantProvisioningOperation"`,
      `TRUNCATE "TenantProvisioningOperation"`,
    ]) {
      await expect(sql((c) => c.query(statement))).rejects.toThrow(
        /append-only/,
      );
    }
  });

  it('the rollback refuses while provisioning data exists, changing nothing', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/SC1d rollback refused/);
    expect(await columnsOf('TenantProvisioningOperation')).not.toEqual([]);
  });

  it('on a database without provisioning data, the rollback restores the previous shape', async () => {
    const empty = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc1d_rollback',
    );
    try {
      await applyMigrations(empty.url, listMigrations(MIGRATIONS));
      await applyMigrationSql(empty.url, readFileSync(ROLLBACK, 'utf8'));
      const shape = await withScratchClient(empty.url, async (c) => ({
        table: (
          await c.query(
            `SELECT to_regclass('public."TenantProvisioningOperation"') AS t`,
          )
        ).rows[0] as { t: string | null },
        columns: (
          await c.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
              WHERE table_name = 'PlatformAuditEvent' AND column_name LIKE 'target%'`,
          )
        ).rows,
      }));
      expect(shape).toEqual({ table: { t: null }, columns: [] });
    } finally {
      await empty.drop();
    }
  });
});
