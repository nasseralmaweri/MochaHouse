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

// SC4f-3a — migration 20261112090000_storefront_publishing, on scratch
// databases: the storefront.manage permission is accepted (and only known
// permissions are); the address history needs a known action, a reason, an
// existing address and operator, and is append-only; and a rollback that
// refuses while any history or storefront.manage grant exists and otherwise
// restores the previous shape.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261112090000_storefront_publishing.down.sql',
);

jest.setTimeout(180_000);

describe('SC4f-3a storefront publishing migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  let operatorId: string;
  let hostId: string;
  const query = (text: string, params: unknown[] = []) =>
    withScratchClient(scratch.url, (c) =>
      c.query<Record<string, unknown> & { id: string }>(text, params),
    );
  const insertOperator = (url: string, tag: string) =>
    withScratchClient(
      url,
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO "PlatformOperator" (id, "externalProvider", "externalSubject", email, status, "updatedAt")
           VALUES (gen_random_uuid()::text, 'platform-dev', $1, $2, 'ACTIVE', now()) RETURNING id`,
            [`platform-dev:${tag}`, `${tag}@example.test`],
          )
        ).rows[0].id,
    );
  const insertHost = (url: string, hostname: string) =>
    withScratchClient(
      url,
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO "StorefrontHost" (id, hostname, "storefrontTenantId", kind, "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, 'LEGACY', now()) RETURNING id`,
            [hostname, TENANT_1_MOCHA_HOUSE_ID],
          )
        ).rows[0].id,
    );
  const insertChange = (action: string, reason: string, host = hostId) =>
    query(
      `INSERT INTO "StorefrontHostChange" (id, "storefrontHostId", action, reason, "actorPlatformOperatorId")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4) RETURNING id`,
      [host, action, reason, operatorId],
    );

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4f3a_migration',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    operatorId = await insertOperator(scratch.url, 'sc4f3a-mig');
    hostId = await insertHost(scratch.url, 'order.mochahouse.test');
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('accepts storefront.manage and still refuses unknown permissions', async () => {
    const grant = (permission: string) =>
      query(
        `INSERT INTO "PlatformOperatorPermission" (id, "operatorId", permission, "grantReason")
         VALUES (gen_random_uuid()::text, $1, $2, 'Migration test grant reason') RETURNING id`,
        [operatorId, permission],
      );
    await grant('storefront.manage');
    await expect(grant('storefront.everything')).rejects.toThrow();
  });

  it('keeps the address history valid and append-only', async () => {
    await expect(
      insertChange('MOVED', 'A valid reason here'),
    ).rejects.toThrow();
    await expect(insertChange('PUBLISHED', 'too short')).rejects.toThrow();
    await expect(insertChange('PUBLISHED', ' '.repeat(20))).rejects.toThrow();
    await expect(
      insertChange(
        'PUBLISHED',
        'A valid reason here',
        '00000000-0000-0000-0000-000000000000',
      ),
    ).rejects.toThrow();
    const id = (await insertChange('ASSIGNED', 'Approved existing address'))
      .rows[0].id;
    await expect(
      query(
        `UPDATE "StorefrontHostChange" SET reason = 'Changed reason text' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      query(`DELETE FROM "StorefrontHostChange" WHERE id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
    await expect(query(`TRUNCATE "StorefrontHostChange"`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('the rollback refuses while history or storefront.manage grants exist', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    expect(
      (
        await query(
          `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'StorefrontHostChange'`,
        )
      ).rows[0],
    ).toEqual({ n: 1 });
  });

  it('the rollback restores the previous shape when nothing exists', async () => {
    const clean = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4f3a_rollback_clean',
    );
    try {
      await applyMigrations(clean.url, listMigrations(MIGRATIONS));
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      const id = await insertOperator(clean.url, 'sc4f3a-after');
      await withScratchClient(clean.url, async (c) => {
        const tables = await c.query(
          `SELECT 1 FROM information_schema.tables WHERE table_name = 'StorefrontHostChange'`,
        );
        expect(tables.rows).toEqual([]);
        const grant = (permission: string) =>
          c.query(
            `INSERT INTO "PlatformOperatorPermission" (id, "operatorId", permission, "grantReason")
             VALUES (gen_random_uuid()::text, $1, $2, 'Rollback test grant reason')`,
            [id, permission],
          );
        await expect(grant('storefront.manage')).rejects.toThrow();
        await grant('onboarding.manage');
        // SC4f-1's registry is untouched.
        const registry = await c.query(
          `SELECT 1 FROM information_schema.tables WHERE table_name = 'StorefrontHost'`,
        );
        expect(registry.rows).toHaveLength(1);
      });
    } finally {
      await clean.drop();
    }
  });
});
