import 'dotenv/config';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { INTERNAL_PERMISSION_KEYS } from '@mocha-house/contracts';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  type ScratchDatabase,
} from '@mocha-house/testing';
import {
  SeedRefusedError,
  assertSeedSafe,
  classifySeedTarget,
  isLoopbackHost,
  productionSignal,
} from '@mocha-house/database/dist/testing/seed-guard';

// Seed safety (audit DB2-1 / DB2-2). prisma/seed.ts is development and test
// bootstrap data: it must refuse production, staging and live environments
// and ambiguous or remote databases; a normal re-run must never reactivate a
// user, restore a revoked permission or revert HQ's changes; and the explicit
// SEED_RESET=1 restore is only allowed on a verified disposable database.
//
// Part 1 decides everything that can be decided without a database. Part 2
// runs the REAL seed script as a child process against scratch databases.

jest.setTimeout(300_000);

const databaseDir = join(__dirname, '../../../../packages/database');
const migrationsDir = join(databaseDir, 'prisma/migrations');
const baseUrl = process.env.DATABASE_URL!;
const token = process.env.CENTERIVO_TEST_DB_TOKEN!;
const PASSWORD = 'sup3rS3cretPassw0rd';
const ADMIN_EMAIL = 'admin@mochahouse.test';

const urlWith = (database: string, host = 'localhost') =>
  `postgresql://seeduser:${PASSWORD}@${host}:5432/${database}`;

describe('seed guard — decisions that need no database', () => {
  it('productionSignal names the variable for every production-like value', () => {
    for (const value of [
      'production',
      'prod',
      'staging',
      'live',
      ' Production ',
    ]) {
      expect(productionSignal({ NODE_ENV: value })).toBe('NODE_ENV');
    }
    for (const name of [
      'CENTERIVO_ENV',
      'APP_ENV',
      'DEPLOYMENT_ENV',
      'ENVIRONMENT',
    ]) {
      expect(
        productionSignal({ NODE_ENV: 'development', [name]: 'staging' }),
      ).toBe(name);
    }
    expect(productionSignal({ NODE_ENV: 'development' })).toBeNull();
    expect(productionSignal({ NODE_ENV: 'test', APP_ENV: 'qa' })).toBeNull();
    expect(productionSignal({})).toBeNull();
  });

  it('refuses a production signal even for a marked-looking test run', () => {
    const url = urlWith('mocha_ci_test');
    const testRun = {
      CENTERIVO_TEST_DATABASE: '1',
      CENTERIVO_TEST_DB_TOKEN: 'a'.repeat(20),
    };
    for (const env of [
      { ...testRun, NODE_ENV: 'production' },
      { ...testRun, NODE_ENV: 'staging' },
      { ...testRun, NODE_ENV: 'test', CENTERIVO_ENV: 'live' },
      { ...testRun, NODE_ENV: 'test', APP_ENV: 'prod' },
      { ...testRun, NODE_ENV: 'test', DEPLOYMENT_ENV: 'production' },
      { ...testRun, NODE_ENV: 'test', ENVIRONMENT: 'staging' },
    ]) {
      expect(() => classifySeedTarget(env, url)).toThrow(SeedRefusedError);
      expect(() => classifySeedTarget(env, url)).toThrow(/environment/);
    }
  });

  it('refuses ambiguous database targets', () => {
    const dev = { NODE_ENV: 'development' };
    const cases: Array<[string, Record<string, string>, string | undefined]> = [
      ['no URL', dev, undefined],
      ['not a URL', dev, 'not a url'],
      ['not PostgreSQL', dev, `mysql://u:${PASSWORD}@localhost/db`],
      ['two hosts', dev, `postgresql://u:${PASSWORD}@localhost,db:5432/db`],
      ['no database', dev, `postgresql://u:${PASSWORD}@localhost:5432/`],
      [
        'connection options',
        dev,
        `${urlWith('devdb')}?options=-c%20search_path%3Dx`,
      ],
      ['PGOPTIONS', { ...dev, PGOPTIONS: '-c x=1' }, urlWith('devdb')],
      [
        'a different DIRECT_URL',
        { ...dev, DIRECT_URL: urlWith('otherdb') },
        urlWith('devdb'),
      ],
      [
        'a DIRECT_URL on another host',
        { ...dev, DIRECT_URL: urlWith('devdb', '127.0.0.2') },
        urlWith('devdb'),
      ],
    ];
    for (const [label, env, url] of cases) {
      let thrown: unknown = null;
      try {
        classifySeedTarget(env, url);
      } catch (error) {
        thrown = error;
      }
      expect([label, thrown instanceof SeedRefusedError]).toEqual([
        label,
        true,
      ]);
    }
  });

  it('only loopback hosts count as local, and anything else must be a verified test database', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      '127.0.0.1',
      '127.9.9.9',
      '[::1]',
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of [
      '10.0.0.5',
      '0.0.0.0',
      'db.internal',
      'localhost.evil.example',
      '127.0.0.1.evil.example',
      '192.0.2.1',
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
    const dev = { NODE_ENV: 'development' };
    expect(classifySeedTarget(dev, urlWith('devdb'))).toEqual({
      mode: 'local',
      database: 'devdb',
    });
    expect(classifySeedTarget(dev, urlWith('devdb', '127.0.0.1')).mode).toBe(
      'local',
    );
    expect(() =>
      classifySeedTarget(dev, urlWith('devdb', 'db.internal')),
    ).toThrow(/loopback/);
    // A test-named database or a declared test run is "disposable": it must
    // then prove it (that check is covered by the integration tests below).
    expect(classifySeedTarget(dev, urlWith('mocha_test')).mode).toBe(
      'disposable',
    );
    expect(
      classifySeedTarget({ NODE_ENV: 'test' }, urlWith('devdb')).mode,
    ).toBe('disposable');
  });

  it('local mode never authorises a reset and creates the dev admin only on opt-in', async () => {
    const dev = { NODE_ENV: 'development' };
    const url = urlWith('devdb', '127.0.0.1');
    expect(await assertSeedSafe(dev, url)).toEqual({
      mode: 'local',
      database: 'devdb',
      reset: false,
      devAdmin: false,
    });
    expect(await assertSeedSafe({ ...dev, SEED_DEV_ADMIN: '1' }, url)).toEqual(
      expect.objectContaining({ mode: 'local', reset: false, devAdmin: true }),
    );
    expect(
      (await assertSeedSafe({ ...dev, SEED_DEV_ADMIN: 'true' }, url)).devAdmin,
    ).toBe(false);
    expect((await assertSeedSafe({ ...dev, SEED_RESET: '0' }, url)).reset).toBe(
      false,
    );
    for (const value of ['1', 'yes', 'true']) {
      await expect(
        assertSeedSafe({ ...dev, SEED_RESET: value }, url),
      ).rejects.toThrow(SeedRefusedError);
    }
    await expect(
      assertSeedSafe({ ...dev, SEED_RESET: '1' }, url),
    ).rejects.toThrow(/verified disposable/);
  });

  it('refusals never print the connection string, user, password or host', async () => {
    const bad: Array<[Record<string, string>, string]> = [
      [{ NODE_ENV: 'production' }, urlWith('devdb')],
      [{ NODE_ENV: 'development' }, urlWith('devdb', 'db.internal')],
      [{ NODE_ENV: 'development', SEED_RESET: '1' }, urlWith('devdb')],
      [{ NODE_ENV: 'development' }, `${urlWith('devdb')}?options=x`],
    ];
    for (const [env, url] of bad) {
      const error = await assertSeedSafe(env, url).then(
        () => null,
        (e: Error) => e,
      );
      expect(error).toBeInstanceOf(SeedRefusedError);
      for (const secret of [PASSWORD, 'seeduser', 'db.internal', url]) {
        expect(error!.message).not.toContain(secret);
      }
    }
  });
});

// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

const CLEARED = [
  'CENTERIVO_ENV',
  'APP_ENV',
  'DEPLOYMENT_ENV',
  'ENVIRONMENT',
  'SEED_RESET',
  'SEED_DEV_ADMIN',
  'PGOPTIONS',
  'DIRECT_URL',
  'DIRECT_DATABASE_URL',
  'SHADOW_DATABASE_URL',
  'CENTERIVO_TEST_DATABASE',
  'CENTERIVO_TEST_DB_TOKEN',
];

// The environment of a declared test run, as CI sets it.
const TEST_ENV: Env = {
  NODE_ENV: 'test',
  CENTERIVO_TEST_DATABASE: '1',
  CENTERIVO_TEST_DB_TOKEN: token,
};
// An ordinary development run: nothing declared.
const PLAIN_ENV: Env = { NODE_ENV: 'development' };

function childEnv(url: string, env: Env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...process.env };
  for (const name of CLEARED) delete result[name];
  result.DATABASE_URL = url;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete result[name];
    else result[name] = value;
  }
  return result;
}

async function runSeed(
  url: string,
  env: Env,
): Promise<{ code: number; out: string }> {
  return promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'prisma/seed.ts'],
    { cwd: databaseDir, env: childEnv(url, env), timeout: 180_000 },
  ).then(
    (r) => ({ code: 0, out: `${r.stdout}${r.stderr}` }),
    (e: { code?: number; stdout?: string; stderr?: string }) => ({
      code: typeof e.code === 'number' ? e.code : 1,
      out: `${e.stdout ?? ''}${e.stderr ?? ''}`,
    }),
  );
}

async function q<T = Record<string, unknown>>(
  url: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

const hex = () => randomBytes(3).toString('hex');
const baseHost = new URL(baseUrl).hostname;
const urlFor = (database: string) => {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
};

// Everything the seed manages that HQ can change.
async function snapshot(url: string) {
  const one = async <T>(sql: string) => (await q<T>(url, sql))[0];
  return {
    adminStatus: (
      await one<{ status: string }>(
        `SELECT status FROM "InternalUser" WHERE email = '${ADMIN_EMAIL}'`,
      )
    )?.status,
    adminAssignments: (
      await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM "InternalUserRoleAssignment" a
           JOIN "InternalUser" u ON u.id = a."internalUserId"
          WHERE u.email = '${ADMIN_EMAIL}'`,
      )
    ).n,
    locations: (
      await q<{ slug: string; active: string }>(
        url,
        `SELECT slug, "isActive"::text || '/' || "isDigitalOrderingEnabled"::text AS active
           FROM "Location" ORDER BY slug`,
      )
    ).map((l) => `${l.slug}:${l.active}`),
    overrides: (
      await one<{ n: number }>(
        `SELECT ((SELECT count(*) FROM "LocationProductPriceOverride")
               + (SELECT count(*) FROM "LocationProductAvailabilityOverride"))::int AS n`,
      )
    ).n,
    medium: (
      await one<{ v: string }>(
        `SELECT "priceAdjustment"::text || '/' || "isActive"::text AS v
           FROM "ModifierOption" WHERE name = 'Medium'`,
      )
    ).v,
    storeManagerPermissions: (
      await q<{ k: string }>(
        url,
        `SELECT p."permissionKey" AS k FROM "InternalRolePermission" p
           JOIN "InternalRole" r ON r.id = p."roleId" WHERE r.key = 'store-manager'
          ORDER BY 1`,
      )
    ).map((r) => r.k),
    platformPermissions: (
      await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM "InternalRolePermission" p
           JOIN "InternalRole" r ON r.id = p."roleId" WHERE r.key = 'platform-administrator'`,
      )
    ).n,
    openingTemplateActive: (
      await one<{ a: boolean }>(
        `SELECT "isActive" AS a FROM "ChecklistTemplate" WHERE key = 'opening'`,
      )
    ).a,
  };
}

// What HQ might do in the Admin UI (or an operator might do by hand).
async function applyHqChanges(url: string) {
  const sql = [
    `UPDATE "InternalUser" SET status = 'SUSPENDED' WHERE email = '${ADMIN_EMAIL}'`,
    `DELETE FROM "InternalUserRoleAssignment"
      WHERE "internalUserId" = (SELECT id FROM "InternalUser" WHERE email = '${ADMIN_EMAIL}')`,
    `UPDATE "Location" SET "isActive" = false, "isDigitalOrderingEnabled" = false`,
    `INSERT INTO "LocationProductPriceOverride"("locationId","menuId","productId",price,"updatedAt","tenantId")
       SELECT l.id, mp."menuId", mp."productId", 999, now(), l."tenantId"
         FROM "Location" l, "MenuProduct" mp WHERE l.slug = 'dearborn-heights' LIMIT 1`,
    `INSERT INTO "LocationProductAvailabilityOverride"("locationId","menuId","productId","isAvailable","updatedAt","tenantId")
       SELECT l.id, mp."menuId", mp."productId", false, now(), l."tenantId"
         FROM "Location" l, "MenuProduct" mp WHERE l.slug = 'dearborn-heights' LIMIT 1`,
    `UPDATE "ModifierOption" SET "priceAdjustment" = 999, "isActive" = false WHERE name = 'Medium'`,
    `DELETE FROM "InternalRolePermission" WHERE "permissionKey" = 'orders.view'
       AND "roleId" IN (SELECT id FROM "InternalRole" WHERE key IN ('store-manager','platform-administrator'))`,
    `UPDATE "ChecklistTemplate" SET "isActive" = false WHERE key = 'opening'`,
  ];
  for (const statement of sql) await q(url, statement);
}

describe('seed script — normal re-run vs SEED_RESET on a verified disposable database', () => {
  let scratch: ScratchDatabase;
  let fresh: Awaited<ReturnType<typeof snapshot>>;

  beforeAll(async () => {
    scratch = await createScratchDatabase(baseUrl, 'seed_safety');
    await applyMigrations(scratch.url, listMigrations(migrationsDir));
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('a fresh seed creates the dev admin, its assignment and the built-in role permissions', async () => {
    const result = await runSeed(scratch.url, TEST_ENV);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/mode: disposable, reset: no, dev admin: yes/);
    fresh = await snapshot(scratch.url);
    expect(fresh.adminStatus).toBe('ACTIVE');
    expect(fresh.adminAssignments).toBe(1);
    expect(fresh.platformPermissions).toBe(INTERNAL_PERMISSION_KEYS.length);
    expect(fresh.storeManagerPermissions).toContain('orders.view');
    expect(fresh.locations).toEqual([
      'ann-arbor:true/true',
      'dearborn-heights:true/true',
    ]);
    expect(fresh.overrides).toBe(0);
    expect(fresh.openingTemplateActive).toBe(true);
  });

  it('re-running the seed keeps every HQ change (nothing reactivated, restored or deleted)', async () => {
    await applyHqChanges(scratch.url);
    const changed = await snapshot(scratch.url);
    expect(changed.adminStatus).toBe('SUSPENDED');
    expect(changed.overrides).toBe(2);

    const result = await runSeed(scratch.url, TEST_ENV);
    expect(result.code).toBe(0);
    expect(await snapshot(scratch.url)).toEqual(changed);
    // And a second time: still unchanged.
    expect((await runSeed(scratch.url, TEST_ENV)).code).toBe(0);
    expect(await snapshot(scratch.url)).toEqual(changed);
  });

  it('a refused run (staging signal) changes nothing', async () => {
    const before = await snapshot(scratch.url);
    for (const env of [
      { ...TEST_ENV, CENTERIVO_ENV: 'staging' },
      { ...TEST_ENV, SEED_RESET: '1', DEPLOYMENT_ENV: 'production' },
    ]) {
      const result = await runSeed(scratch.url, env);
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(
        /Refusing to run the development seed \(environment\)/,
      );
    }
    expect(await snapshot(scratch.url)).toEqual(before);
  });

  it('SEED_RESET=1 restores the seeded defaults on a verified disposable database', async () => {
    const result = await runSeed(scratch.url, { ...TEST_ENV, SEED_RESET: '1' });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/reset: yes/);
    expect(await snapshot(scratch.url)).toEqual(fresh);
  });

  it('SEED_RESET=1 with an unmarked database (disposable by name only) is refused and writes nothing', async () => {
    const database = `mocha_seedsafety_${hex()}_test`;
    await q(baseUrl, `CREATE DATABASE "${database}"`);
    try {
      const result = await runSeed(urlFor(database), {
        ...TEST_ENV,
        SEED_RESET: '1',
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(
        /Refusing to use this database for destructive tests/,
      );
      expect(
        (
          await q<{ n: number }>(
            urlFor(database),
            `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`,
          )
        )[0].n,
      ).toBe(0);
    } finally {
      await q(baseUrl, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    }
  });
});

describe('seed script — production, remote and ordinary local databases', () => {
  const created: string[] = [];
  const createUnmarked = async (suffix: string) => {
    const database = `seedsafety_${hex()}_${suffix}`;
    await q(baseUrl, `CREATE DATABASE "${database}"`);
    created.push(database);
    return database;
  };
  const tableCount = async (database: string) =>
    (
      await q<{ n: number }>(
        urlFor(database),
        `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`,
      )
    )[0].n;

  afterAll(async () => {
    for (const database of created) {
      await q(baseUrl, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    }
  });

  it('refuses a production run on a non-test-named database, writes nothing and never prints credentials', async () => {
    const database = await createUnmarked('prodlike');
    for (const env of [
      { NODE_ENV: 'production' },
      { NODE_ENV: 'development', CENTERIVO_ENV: 'live' },
      { NODE_ENV: 'staging' },
    ]) {
      const result = await runSeed(urlFor(database), env);
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(
        /Refusing to run the development seed \(environment\)/,
      );
      expect(result.out).not.toContain(
        new URL(baseUrl).password || 'no-password',
      );
      expect(result.out).not.toContain(baseUrl);
    }
    expect(await tableCount(database)).toBe(0);
  });

  it('refuses a remote (non-loopback) non-test database before connecting', async () => {
    const result = await runSeed(urlWith('devdb', '192.0.2.1'), PLAIN_ENV);
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(
      /Refusing to run the development seed \(connection\)/,
    );
    expect(result.out).not.toContain(PASSWORD);
    expect(result.out).not.toContain('192.0.2.1');
  });

  const itLocal = isLoopbackHost(baseHost) ? it : it.skip;

  itLocal(
    'an ordinary local database seeds create-once data, no dev admin unless opted in, and never resets',
    async () => {
      const database = await createUnmarked('local');
      const url = urlFor(database);
      await applyMigrations(url, listMigrations(migrationsDir));

      const first = await runSeed(url, PLAIN_ENV);
      expect(first.code).toBe(0);
      expect(first.out).toMatch(/mode: local, reset: no, dev admin: no/);
      expect((await snapshot(url)).adminStatus).toBeUndefined();
      expect((await snapshot(url)).platformPermissions).toBe(
        INTERNAL_PERMISSION_KEYS.length,
      );

      const withAdmin = await runSeed(url, {
        ...PLAIN_ENV,
        SEED_DEV_ADMIN: '1',
      });
      expect(withAdmin.code).toBe(0);
      expect((await snapshot(url)).adminStatus).toBe('ACTIVE');
      expect((await snapshot(url)).adminAssignments).toBe(1);

      await applyHqChanges(url);
      const changed = await snapshot(url);
      expect(
        (await runSeed(url, { ...PLAIN_ENV, SEED_DEV_ADMIN: '1' })).code,
      ).toBe(0);
      expect(await snapshot(url)).toEqual(changed);

      // Localhost alone never authorises a reset.
      const reset = await runSeed(url, { ...PLAIN_ENV, SEED_RESET: '1' });
      expect(reset.code).not.toBe(0);
      expect(reset.out).toMatch(
        /Refusing to run the development seed \(reset\)/,
      );
      expect(await snapshot(url)).toEqual(changed);
    },
  );
});
