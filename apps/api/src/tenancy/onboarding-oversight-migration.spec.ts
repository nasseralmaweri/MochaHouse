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

// SC4e — migration 20261109090000_onboarding_oversight, on scratch
// databases: the two new operator permissions are accepted (and only known
// permissions are); the registration pause history needs a reason and an
// operator and is append-only; and a rollback that refuses while any pause
// history or onboarding grant exists and otherwise restores the SC4d shape.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261109090000_onboarding_oversight.down.sql',
);

jest.setTimeout(180_000);

describe('SC4e onboarding oversight migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  let operatorId: string;
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

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4e_migration',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    operatorId = await insertOperator(scratch.url, 'sc4e-mig');
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('accepts the onboarding permissions and still refuses unknown ones', async () => {
    const grant = (permission: string) =>
      query(
        `INSERT INTO "PlatformOperatorPermission" (id, "operatorId", permission, "grantReason")
         VALUES (gen_random_uuid()::text, $1, $2, 'Migration test grant reason') RETURNING id`,
        [operatorId, permission],
      );
    await grant('onboarding.view');
    await grant('onboarding.manage');
    await expect(grant('onboarding.everything')).rejects.toThrow();
  });

  it('keeps the pause history valid and append-only', async () => {
    const insert = (paused: boolean, reason: string, actor = operatorId) =>
      query(
        `INSERT INTO "RegistrationControlChange" (id, paused, reason, "actorPlatformOperatorId")
         VALUES (gen_random_uuid()::text, $1, $2, $3) RETURNING id`,
        [paused, reason, actor],
      );
    await expect(insert(true, 'too short')).rejects.toThrow();
    await expect(insert(true, ' '.repeat(20))).rejects.toThrow();
    await expect(
      insert(
        true,
        'A valid reason here',
        '00000000-0000-0000-0000-000000000000',
      ),
    ).rejects.toThrow();
    const id = (await insert(true, 'Abuse spike from one domain')).rows[0].id;
    await expect(
      query(
        `UPDATE "RegistrationControlChange" SET paused = false WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      query(`DELETE FROM "RegistrationControlChange" WHERE id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
    await expect(query(`TRUNCATE "RegistrationControlChange"`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('the rollback refuses while pause history or onboarding grants exist', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    expect(
      (
        await query(
          `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'RegistrationControlChange'`,
        )
      ).rows[0],
    ).toEqual({ n: 1 });
  });

  it('the rollback restores the previous shape when nothing exists', async () => {
    const clean = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4e_rollback_clean',
    );
    try {
      await applyMigrations(clean.url, listMigrations(MIGRATIONS));
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      const id = await insertOperator(clean.url, 'sc4e-after');
      await withScratchClient(clean.url, async (c) => {
        const tables = await c.query(
          `SELECT 1 FROM information_schema.tables WHERE table_name = 'RegistrationControlChange'`,
        );
        expect(tables.rows).toEqual([]);
        const grant = (permission: string) =>
          c.query(
            `INSERT INTO "PlatformOperatorPermission" (id, "operatorId", permission, "grantReason")
             VALUES (gen_random_uuid()::text, $1, $2, 'Rollback test grant reason')`,
            [id, permission],
          );
        await expect(grant('onboarding.view')).rejects.toThrow();
        await grant('billing.reports.view');
      });
    } finally {
      await clean.drop();
    }
  });
});
