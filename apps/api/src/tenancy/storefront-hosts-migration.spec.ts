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

// SC4f-1 — migration 20261110090000_storefront_hosts, on scratch databases:
// only normalized DNS hostnames (or "localhost") are accepted, each belongs
// to exactly one existing business, publishing state stays consistent, an
// approved address never changes owner, hostname or kind and is never
// removed; and a rollback that refuses while any approved hostname exists
// and otherwise removes the registry.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const ROLLBACK = join(
  __dirname,
  '../../../../packages/database/prisma/rollbacks/20261110090000_storefront_hosts.down.sql',
);

jest.setTimeout(180_000);

describe('SC4f-1 storefront hosts migration (scratch database)', () => {
  let scratch: ScratchDatabase;
  const query = (text: string, params: unknown[] = []) =>
    withScratchClient(scratch.url, (c) =>
      c.query<Record<string, unknown> & { id: string }>(text, params),
    );
  const insert = (
    hostname: string,
    opts: {
      tenantId?: string;
      kind?: string;
      published?: boolean;
      publishedAt?: Date | null;
    } = {},
  ) =>
    query(
      `INSERT INTO "StorefrontHost" (id, hostname, "storefrontTenantId", kind, published, "publishedAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, now()) RETURNING id`,
      [
        hostname,
        opts.tenantId ?? TENANT_1_MOCHA_HOUSE_ID,
        opts.kind ?? 'PLATFORM_SUBDOMAIN',
        opts.published ?? false,
        opts.publishedAt ?? null,
      ],
    );

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4f1_migration',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('accepts only normalized DNS hostnames or localhost', async () => {
    await insert('mocha.centerivo.test');
    await insert('localhost', { kind: 'LEGACY' });
    for (const bad of [
      'Mocha.centerivo.test',
      'mocha.centerivo.test.',
      'mocha.centerivo.test:443',
      'single',
      '-bad.centerivo.test',
      'bad-.centerivo.test',
      'under_score.centerivo.test',
      '10.0.0.1',
      `${'a'.repeat(64)}.centerivo.test`,
      '',
    ]) {
      await expect(insert(bad)).rejects.toThrow();
    }
  });

  it('keeps one owner per hostname, an existing business, a known kind and consistent publishing', async () => {
    await expect(insert('mocha.centerivo.test')).rejects.toThrow();
    await expect(
      insert('ghost.centerivo.test', {
        tenantId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow();
    await expect(
      insert('kind.centerivo.test', { kind: 'WILDCARD' }),
    ).rejects.toThrow();
    await expect(
      insert('pub1.centerivo.test', { published: true }),
    ).rejects.toThrow();
    await expect(
      insert('pub2.centerivo.test', { publishedAt: new Date() }),
    ).rejects.toThrow();
    await insert('pub3.centerivo.test', {
      published: true,
      publishedAt: new Date(),
    });
  });

  it('lets only the publishing state change, and never removes a row', async () => {
    const id = (await insert('guard.centerivo.test')).rows[0].id;
    await query(
      `UPDATE "StorefrontHost" SET published = true, "publishedAt" = now(), "updatedAt" = now() WHERE id = $1`,
      [id],
    );
    await query(
      `UPDATE "StorefrontHost" SET published = false, "publishedAt" = NULL, "updatedAt" = now() WHERE id = $1`,
      [id],
    );
    for (const change of [
      `hostname = 'other.centerivo.test'`,
      `kind = 'CUSTOM'`,
      `"createdAt" = now() - interval '1 day'`,
      `"storefrontTenantId" = 'x'`,
    ]) {
      await expect(
        query(`UPDATE "StorefrontHost" SET ${change} WHERE id = $1`, [id]),
      ).rejects.toThrow(/never changes/);
    }
    await expect(
      query(`DELETE FROM "StorefrontHost" WHERE id = $1`, [id]),
    ).rejects.toThrow(/never removed/);
    await expect(query(`TRUNCATE "StorefrontHost"`)).rejects.toThrow(
      /never removed/,
    );
    // The business itself cannot be deleted from under its hostnames.
    await expect(
      query(`DELETE FROM "Tenant" WHERE id = $1`, [TENANT_1_MOCHA_HOUSE_ID]),
    ).rejects.toThrow();
  });

  it('the rollback refuses while any approved hostname exists', async () => {
    await expect(
      applyMigrationSql(scratch.url, readFileSync(ROLLBACK, 'utf8')),
    ).rejects.toThrow(/rollback refused/);
    expect(
      (
        await query(
          `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'StorefrontHost'`,
        )
      ).rows[0],
    ).toEqual({ n: 1 });
  });

  it('the rollback removes the registry when it is empty', async () => {
    const clean = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4f1_rollback_clean',
    );
    try {
      await applyMigrations(clean.url, listMigrations(MIGRATIONS));
      await applyMigrationSql(clean.url, readFileSync(ROLLBACK, 'utf8'));
      await withScratchClient(clean.url, async (c) => {
        const tables = await c.query(
          `SELECT 1 FROM information_schema.tables WHERE table_name = 'StorefrontHost'`,
        );
        expect(tables.rows).toEqual([]);
        const fn = await c.query(
          `SELECT 1 FROM pg_proc WHERE proname = 'guard_storefront_host'`,
        );
        expect(fn.rows).toEqual([]);
        // The rest of the schema is untouched.
        const tenant = await c.query(`SELECT id FROM "Tenant" WHERE id = $1`, [
          TENANT_1_MOCHA_HOUSE_ID,
        ]);
        expect(tenant.rows).toHaveLength(1);
      });
    } finally {
      await clean.drop();
    }
  });
});
