import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  DISPOSABLE_NAME_SETTING,
  DISPOSABLE_TOKEN_SETTING,
  DisposableDatabaseError,
  TEST_TENANT_B_ID,
  assertApprovedTestTenants,
  assertDisposableDatabase,
  assertTestEnvironment,
  assertUnambiguousTestUrl,
  createDisposableDatabase,
  createScratchDatabase,
  dropDisposableDatabase,
  removeTestTenant,
} from '@mocha-house/testing';

// Security 4C-1 — the disposable-database guard refuses everything that is
// not provably a test database created for this run, and every refusal is
// specific and leaks no connection details. Positive paths prove that
// legitimate setup and teardown still work.

jest.setTimeout(120_000);

const baseUrl = process.env.DATABASE_URL!;
const token = process.env.CENTERIVO_TEST_DB_TOKEN!;

const GOOD_ENV = {
  NODE_ENV: 'test',
  CENTERIVO_TEST_DATABASE: '1',
  CENTERIVO_TEST_DB_TOKEN: 'a-valid-test-token-1234',
};
const GOOD_URL = 'postgresql://u:p@localhost:5432/mocha_ci?schema=public';

const urlFor = (database: string) => {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
};
const scratchName = (label: string) =>
  `mh_scratch_guard_${label}_${randomBytes(3).toString('hex')}`;

async function raw<T>(url: string, fn: (c: Client) => Promise<T>) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
// Test-owned databases created WITHOUT the guard (to prove it refuses
// them) are dropped here directly by this spec.
const rawCreated: string[] = [];
async function createUnmarked(name: string) {
  await raw(baseUrl, (c) => c.query(`CREATE DATABASE "${name}"`));
  rawCreated.push(name);
}
async function markerOf(name: string): Promise<string[]> {
  return raw(baseUrl, async (c) => {
    const { rows } = await c.query<{ setconfig: string[] | null }>(
      `SELECT s.setconfig FROM pg_db_role_setting s
         JOIN pg_database d ON d.oid = s.setdatabase
        WHERE d.datname = $1 AND s.setrole = 0`,
      [name],
    );
    return rows[0]?.setconfig ?? [];
  });
}
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DisposableDatabaseError);
    return (error as Error).message;
  }
  throw new Error('expected a DisposableDatabaseError');
}
const refusalSync = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DisposableDatabaseError);
    return (error as Error).message;
  }
  throw new Error('expected a DisposableDatabaseError');
};

describe('Disposable database guard (Security 4C-1)', () => {
  const guardCreated: string[] = [];
  afterAll(async () => {
    for (const name of guardCreated) {
      await dropDisposableDatabase(baseUrl, name).catch(() => undefined);
    }
    for (const name of rawCreated) {
      await raw(baseUrl, (c) =>
        c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
      );
    }
  });

  describe('test environment indicators', () => {
    it.each([
      ['NODE_ENV missing', { ...GOOD_ENV, NODE_ENV: undefined }],
      [
        'NODE_ENV=development outside a Jest process',
        { ...GOOD_ENV, NODE_ENV: 'development' },
      ],
      ['NODE_ENV=production', { ...GOOD_ENV, NODE_ENV: 'production' }],
      [
        'NODE_ENV=production even inside a Jest process',
        { ...GOOD_ENV, NODE_ENV: 'production', JEST_WORKER_ID: '1' },
      ],
      [
        'NODE_ENV=staging inside a Jest process',
        { ...GOOD_ENV, NODE_ENV: 'staging', JEST_WORKER_ID: '1' },
      ],
      [
        'CENTERIVO_ENV=production',
        { ...GOOD_ENV, CENTERIVO_ENV: 'production' },
      ],
      ['APP_ENV=staging', { ...GOOD_ENV, APP_ENV: 'Staging' }],
      ['flag missing', { ...GOOD_ENV, CENTERIVO_TEST_DATABASE: undefined }],
      ['flag not "1"', { ...GOOD_ENV, CENTERIVO_TEST_DATABASE: 'true' }],
      ['token missing', { ...GOOD_ENV, CENTERIVO_TEST_DB_TOKEN: undefined }],
      ['token too short', { ...GOOD_ENV, CENTERIVO_TEST_DB_TOKEN: 'short' }],
      [
        'token with unsafe characters',
        { ...GOOD_ENV, CENTERIVO_TEST_DB_TOKEN: "x'; DROP DATABASE y; --aaaa" },
      ],
    ])('refuses when %s', (_label, env) => {
      expect(refusalSync(() => assertTestEnvironment(env))).toMatch(
        /\(environment\)/,
      );
    });

    it('accepts NODE_ENV=development only inside a Jest process (suites using the dev auth providers)', () => {
      expect(
        assertTestEnvironment({
          ...GOOD_ENV,
          NODE_ENV: 'development',
          JEST_WORKER_ID: '1',
        }),
      ).toBe(GOOD_ENV.CENTERIVO_TEST_DB_TOKEN);
    });

    it('accepts a declared test run', () => {
      expect(assertTestEnvironment(GOOD_ENV)).toBe(
        GOOD_ENV.CENTERIVO_TEST_DB_TOKEN,
      );
    });
  });

  describe('unambiguous connection', () => {
    it.each([
      ['no URL', undefined, GOOD_ENV],
      ['not a URL', 'not a url', GOOD_ENV],
      ['not PostgreSQL', 'mysql://u:p@localhost/mocha_ci', GOOD_ENV],
      ['several hosts', 'postgresql://u:p@h1,h2/mocha_ci', GOOD_ENV],
      [
        'connection options',
        'postgresql://u:p@localhost/mocha_ci?options=-c%20centerivo.disposable_token%3Dx',
        GOOD_ENV,
      ],
      ['PGOPTIONS set', GOOD_URL, { ...GOOD_ENV, PGOPTIONS: '-c x=y' }],
      [
        'a non-test database name',
        'postgresql://u:p@localhost/mocha_house',
        GOOD_ENV,
      ],
      [
        'a name merely containing "test"',
        'postgresql://u:p@localhost/latest',
        GOOD_ENV,
      ],
      ['an upper-case name', 'postgresql://u:p@localhost/Mocha_CI', GOOD_ENV],
      [
        'a second URL naming another database',
        GOOD_URL,
        { ...GOOD_ENV, DIRECT_URL: 'postgresql://u:p@localhost/mocha_house' },
      ],
    ])('refuses %s', (_label, url, env) => {
      expect(refusalSync(() => assertUnambiguousTestUrl(url, env))).toMatch(
        /\(connection\)/,
      );
    });

    it('accepts a single test database', () => {
      expect(assertUnambiguousTestUrl(GOOD_URL, GOOD_ENV)).toBe('mocha_ci');
    });
  });

  describe('approved fictional businesses', () => {
    it.each([
      [
        'an unknown business',
        [{ id: '0b8f6d1e-4a1c-7000-8000-123456789abc', slug: 'real-cafe' }],
      ],
      [
        'Tenant #1 under an unexpected slug (ambiguous)',
        [{ id: TENANT_1_MOCHA_HOUSE_ID, slug: 'not-mocha-house' }],
      ],
      [
        'the Mocha House slug under another id (ambiguous)',
        [{ id: TEST_TENANT_B_ID, slug: 'mocha-house' }],
      ],
      [
        'more businesses than a test database holds',
        Array.from({ length: 26 }, (_, i) => ({
          id: `01a0db02-f800-7000-8000-7e57${i.toString(16).padStart(8, '0')}`,
          slug: `t-${i}`,
        })),
      ],
    ])('refuses %s', (_label, tenants) => {
      expect(refusalSync(() => assertApprovedTestTenants(tenants))).toMatch(
        /\(identity\)/,
      );
    });

    it('accepts Mocha House (Tenant #1) and test-only businesses', () => {
      expect(() =>
        assertApprovedTestTenants([
          { id: TENANT_1_MOCHA_HOUSE_ID, slug: 'mocha-house' },
          { id: TEST_TENANT_B_ID, slug: 'test-tenant-b' },
        ]),
      ).not.toThrow();
    });
  });

  describe('database marker (live server)', () => {
    it('accepts the database this run created and marked', async () => {
      await expect(assertDisposableDatabase(baseUrl)).resolves.toEqual(
        expect.objectContaining({
          database: new URL(baseUrl).pathname.slice(1),
        }),
      );
    });

    it('refuses an existing database that carries no marker', async () => {
      const name = scratchName('unmarked');
      await createUnmarked(name);
      expect(await refusal(assertDisposableDatabase(urlFor(name)))).toMatch(
        /\(marker\).*no disposable marker/,
      );
    });

    it('never marks an existing database: creating over it is refused and it stays unmarked', async () => {
      const name = scratchName('existing');
      await createUnmarked(name);
      expect(await refusal(createDisposableDatabase(baseUrl, name))).toMatch(
        /\(create\)/,
      );
      expect(await markerOf(name)).toEqual([]);
    });

    it("refuses a database marked with another run's token", async () => {
      const name = scratchName('token');
      await createDisposableDatabase(baseUrl, name);
      guardCreated.push(name);
      const otherRun = {
        ...process.env,
        CENTERIVO_TEST_DB_TOKEN: 'another-runs-token-0000',
      };
      expect(
        await refusal(assertDisposableDatabase(urlFor(name), otherRun)),
      ).toMatch(/\(marker\).*token does not match/);
    });

    it('refuses a marked database that has been renamed (marker names another database)', async () => {
      const original = scratchName('renamed');
      await createDisposableDatabase(baseUrl, original);
      const renamed = scratchName('renamed2');
      await raw(baseUrl, (c) =>
        c.query(`ALTER DATABASE "${original}" RENAME TO "${renamed}"`),
      );
      rawCreated.push(renamed);
      expect(await markerOf(renamed)).toEqual(
        expect.arrayContaining([`${DISPOSABLE_NAME_SETTING}=${original}`]),
      );
      expect(await refusal(assertDisposableDatabase(urlFor(renamed)))).toMatch(
        /\(marker\).*different database/,
      );
    });

    it('refuses a marked database holding an unknown or ambiguous business', async () => {
      const name = scratchName('identity');
      await createDisposableDatabase(baseUrl, name);
      guardCreated.push(name);
      await raw(urlFor(name), (c) =>
        c.query(
          `CREATE TABLE "Tenant" (id text PRIMARY KEY, slug text NOT NULL)`,
        ),
      );
      await expect(assertDisposableDatabase(urlFor(name))).resolves.toEqual({
        database: name,
        tenantCount: 0,
      });
      await raw(urlFor(name), (c) =>
        c.query(`INSERT INTO "Tenant" VALUES ($1, 'somewhere-else')`, [
          TENANT_1_MOCHA_HOUSE_ID,
        ]),
      );
      expect(await refusal(assertDisposableDatabase(urlFor(name)))).toMatch(
        /\(identity\).*unexpected slug/,
      );
      await raw(urlFor(name), (c) =>
        c.query(
          `UPDATE "Tenant" SET slug = 'mocha-house';
           INSERT INTO "Tenant" VALUES ('0b8f6d1e-4a1c-7000-8000-123456789abc', 'real-cafe')`,
        ),
      );
      expect(await refusal(assertDisposableDatabase(urlFor(name)))).toMatch(
        /\(identity\).*not an approved fictional test business/,
      );
    });

    it('refuses a production declaration even for a correctly marked database', async () => {
      const env = { ...process.env, NODE_ENV: 'production' };
      expect(await refusal(assertDisposableDatabase(baseUrl, env))).toMatch(
        /\(environment\)/,
      );
    });

    it('records the marker in the server catalog with this run’s token', async () => {
      const name = scratchName('catalog');
      await createDisposableDatabase(baseUrl, name);
      guardCreated.push(name);
      expect(await markerOf(name)).toEqual(
        expect.arrayContaining([
          `${DISPOSABLE_NAME_SETTING}=${name}`,
          `${DISPOSABLE_TOKEN_SETTING}=${token}`,
        ]),
      );
    });
  });

  describe('scratch databases and cleanup', () => {
    it('creates, uses and drops a scratch database next to a disposable base', async () => {
      const scratch = await createScratchDatabase(baseUrl, 'guard-positive');
      await expect(
        assertDisposableDatabase(scratch.url),
      ).resolves.toBeDefined();
      await scratch.drop();
      const { rows } = await raw(baseUrl, (c) =>
        c.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [scratch.name]),
      );
      expect(rows).toHaveLength(0);
    });

    it('refuses to create a scratch database next to an undisposable base', async () => {
      const name = scratchName('base');
      await createUnmarked(name);
      expect(await refusal(createScratchDatabase(urlFor(name), 'x'))).toMatch(
        /\(marker\)/,
      );
    });

    it('refuses to drop a database this process did not create', async () => {
      const name = scratchName('foreign');
      await createUnmarked(name);
      expect(await refusal(dropDisposableDatabase(baseUrl, name))).toMatch(
        /\(cleanup\).*not created by this test process/,
      );
      const { rows } = await raw(baseUrl, (c) =>
        c.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name]),
      );
      expect(rows).toHaveLength(1);
      // Nor the database under test itself.
      expect(
        await refusal(
          dropDisposableDatabase(baseUrl, new URL(baseUrl).pathname.slice(1)),
        ),
      ).toMatch(/\(cleanup\)/);
    });

    it('refuses to drop a non-scratch database even if this process created it', async () => {
      const name = `guard_${randomBytes(3).toString('hex')}_test`;
      await createDisposableDatabase(baseUrl, name);
      rawCreated.push(name);
      expect(await refusal(dropDisposableDatabase(baseUrl, name))).toMatch(
        /\(cleanup\).*not a scratch database/,
      );
    });

    it('cleanup helpers refuse to delete Mocha House or any non-test business', async () => {
      const client = {
        tenant: {
          upsert: jest.fn(),
          deleteMany: jest.fn(),
        },
      };
      for (const id of [
        TENANT_1_MOCHA_HOUSE_ID,
        '0b8f6d1e-4a1c-7000-8000-123456789abc',
        'not-a-uuid',
      ]) {
        expect(await refusal(removeTestTenant(client, id))).toMatch(
          /\(cleanup\)/,
        );
      }
      expect(client.tenant.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('refusals never expose connection details', () => {
    it('omits user, password, host and port from every message', async () => {
      const secretUrl =
        'postgresql://leakuser:Sup3rS3cretPw@10.255.255.1:6543/leak_test';
      const messages = [
        await refusal(
          assertDisposableDatabase(secretUrl, {
            ...process.env,
            DATABASE_URL: secretUrl,
          }),
        ),
        refusalSync(() =>
          assertUnambiguousTestUrl(
            'postgresql://leakuser:Sup3rS3cretPw@10.255.255.1:6543/prod_db',
            GOOD_ENV,
          ),
        ),
      ];
      for (const message of messages) {
        for (const secret of [
          'leakuser',
          'Sup3rS3cretPw',
          '10.255.255.1',
          '6543',
        ]) {
          expect(message).not.toContain(secret);
        }
      }
    });
  });
});
