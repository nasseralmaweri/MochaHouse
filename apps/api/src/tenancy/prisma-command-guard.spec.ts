import 'dotenv/config';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';
import {
  createMigrationProject,
  createScratchDatabase,
  listMigrations,
  requiresDisposableDatabase,
  type MigrationProject,
  type ScratchDatabase,
} from '@mocha-house/testing';

// Security follow-up F-1 — a refused disposable-database check can never be
// followed by Prisma creating, migrating or seeding an unguarded database.
//
// `prisma migrate deploy` creates the database its URL names when it does
// not exist. During the Security 4C-5 review a refused
// `db:create-disposable` was followed, in the same shell, by `migrate
// deploy`, which created and migrated an unguarded database. The guard now
// runs inside prisma.config.ts (and the configs of throwaway migration
// projects, and prisma/seed.ts), before Prisma connects. These tests
// deliberately fail the guard in every way a test workflow can, through
// the REAL Prisma CLI, and check that nothing was created or changed — and
// that legitimate guarded workflows and ordinary (non-test) use still work.

jest.setTimeout(300_000);

const repoRoot = join(__dirname, '../../../..');
const databaseDir = join(repoRoot, 'packages/database');
const prismaBin = join(databaseDir, 'node_modules/.bin/prisma');
const tsxBin = join(databaseDir, 'node_modules/.bin/tsx');
const createDisposableCli = join(
  repoRoot,
  'packages/testing/dist/cli/create-disposable-database.js',
);
const baseUrl = process.env.DATABASE_URL!;
const token = process.env.CENTERIVO_TEST_DB_TOKEN!;

// The environment of a declared test run (as CI and the documented local
// sequence set it), with nothing inherited that could change the outcome.
const TEST_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  NODE_ENV: 'test',
  CENTERIVO_TEST_DATABASE: '1',
  CENTERIVO_TEST_DB_TOKEN: token,
};
// An ordinary (non-test) run: development or a real deployment.
const PLAIN_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  NODE_ENV: 'development',
};

const urlFor = (database: string) => {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
};
const hex = () => randomBytes(3).toString('hex');

async function run(
  file: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string }> {
  return promisify(execFile)(file, [...args], {
    cwd: databaseDir,
    env,
    timeout: 180_000,
  }).then(
    (r) => ({ code: 0, out: `${r.stdout}${r.stderr}` }),
    (e: { code?: number; stdout?: string; stderr?: string }) => ({
      code: typeof e.code === 'number' ? e.code : 1,
      out: `${e.stdout ?? ''}${e.stderr ?? ''}`,
    }),
  );
}
const prisma = (
  url: string,
  args: readonly string[],
  env: Record<string, string> = TEST_ENV,
) => run(prismaBin, args, { ...env, DATABASE_URL: url });

async function raw<T>(url: string, fn: (c: Client) => Promise<T>) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
const exists = async (database: string) =>
  (
    await raw(baseUrl, (c) =>
      c.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]),
    )
  ).rowCount === 1;
const tables = async (database: string) =>
  (
    await raw(urlFor(database), (c) =>
      c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`,
      ),
    )
  ).rows[0].n;

// Databases this spec creates WITHOUT the guard (to prove the guard refuses
// them, or to stand in for a real environment) are dropped by this spec.
const rawCreated: string[] = [];
async function createUnmarked(database: string) {
  await raw(baseUrl, (c) => c.query(`CREATE DATABASE "${database}"`));
  rawCreated.push(database);
}
// Defensive: anything the guard failed to stop is removed too.
const mustNotExist: string[] = [];

const REFUSED = /Refusing to use this database for destructive tests/;
// Every Prisma command that creates or changes a database.
const MUTATING_COMMANDS: ReadonlyArray<readonly string[]> = [
  ['migrate', 'deploy'],
  ['migrate', 'reset', '--force'],
  ['db', 'push', '--accept-data-loss'],
  ['db', 'seed'],
];

describe('Prisma command guard (Security follow-up F-1)', () => {
  const scratches: ScratchDatabase[] = [];
  const projects: MigrationProject[] = [];

  afterAll(async () => {
    for (const s of scratches) await s.drop();
    for (const p of projects) p.remove();
    for (const database of [...rawCreated, ...mustNotExist]) {
      await raw(baseUrl, (c) =>
        c.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`),
      );
    }
  });

  describe('which commands and runs are guarded', () => {
    const argv = (...rest: string[]) => ['node', 'prisma', ...rest];
    const testUrl = 'postgresql://u:p@localhost:5432/mocha_ci';
    const plainUrl = 'postgresql://u:p@localhost:5432/mocha_house';

    it('guards every database command of a declared or partially declared test run', () => {
      for (const env of [
        { NODE_ENV: 'test' },
        { CENTERIVO_TEST_DATABASE: '1' },
        { CENTERIVO_TEST_DATABASE: '0' },
        { CENTERIVO_TEST_DB_TOKEN: 'x' },
      ]) {
        for (const command of [
          ['migrate', 'deploy'],
          ['migrate', 'dev'],
          ['migrate', 'reset'],
          ['migrate', 'resolve', '--rolled-back', 'x'],
          ['migrate', 'diff', '--from-config-datasource'],
          ['migrate', 'status'],
          ['db', 'push'],
          ['db', 'seed'],
          ['db', 'execute', '--stdin'],
          ['db', 'pull'],
          ['studio'],
          ['--config', 'x.ts', 'migrate', 'deploy'],
        ]) {
          expect([
            env,
            command,
            requiresDisposableDatabase(argv(...command), env, plainUrl),
          ]).toEqual([env, command, true]);
        }
      }
    });

    it('guards any database command aimed at a test-named database, even with no test declaration', () => {
      for (const url of [
        testUrl,
        'postgresql://u:p@localhost:5432/mocha_test',
        'postgresql://u:p@localhost:5432/Mocha_TEST',
        'postgresql://u:p@localhost:5432/mh_scratch_x',
      ]) {
        expect(
          requiresDisposableDatabase(argv('migrate', 'deploy'), {}, url),
        ).toBe(true);
      }
    });

    it('leaves commands that never touch a database, and ordinary non-test runs, alone', () => {
      for (const command of [
        ['generate'],
        ['validate'],
        ['format'],
        ['version'],
        [],
      ]) {
        expect(
          requiresDisposableDatabase(
            argv(...command),
            { NODE_ENV: 'test' },
            testUrl,
          ),
        ).toBe(false);
      }
      for (const env of [
        {},
        { NODE_ENV: 'development' },
        { NODE_ENV: 'production' },
      ]) {
        expect(
          requiresDisposableDatabase(argv('migrate', 'deploy'), env, plainUrl),
        ).toBe(false);
      }
    });
  });

  describe('a refused check stops Prisma before it connects (real Prisma CLI)', () => {
    it('reproduces the 4C-5 review incident: create refused, then migrate and seed in the same shell — nothing is created', async () => {
      // A name the guard refuses (no `test` / `ci` segment).
      const database = `centerivo_guard_${hex()}`;
      mustNotExist.push(database);
      const url = urlFor(database);
      // The documented local sequence, without `set -e`: each command runs
      // whatever the previous one returned.
      const shell = await run(
        'bash',
        [
          '-c',
          `node ${createDisposableCli}; echo "create=$?"; ${prismaBin} migrate deploy; echo "migrate=$?"; ${prismaBin} db seed; echo "seed=$?"`,
        ],
        { ...TEST_ENV, DATABASE_URL: url },
      );
      expect(shell.out).toMatch(/create=1/);
      expect(shell.out).toMatch(/migrate=1/);
      expect(shell.out).toMatch(/seed=1/);
      expect(shell.out.match(/Refusing to use this database/g)?.length).toBe(3);
      expect(await exists(database)).toBe(false);
    });

    it('a test-named database that was never created is not created by any mutating command', async () => {
      const database = `mocha_guard_${hex()}_test`;
      mustNotExist.push(database);
      for (const command of MUTATING_COMMANDS) {
        const result = await prisma(urlFor(database), command);
        expect([command, result.code, REFUSED.test(result.out)]).toEqual([
          command,
          1,
          true,
        ]);
      }
      expect(await exists(database)).toBe(false);
    });

    it('an existing but unmarked test-named database is refused and left untouched (no migration table, no data)', async () => {
      const database = `mocha_guard_${hex()}_test`;
      await createUnmarked(database);
      for (const command of MUTATING_COMMANDS) {
        const result = await prisma(urlFor(database), command);
        expect([command, result.code, REFUSED.test(result.out)]).toEqual([
          command,
          1,
          true,
        ]);
      }
      expect(await tables(database)).toBe(0);
    });

    it("a database marked for another run's token is refused", async () => {
      const scratch = await createScratchDatabase(baseUrl, 'guard_token');
      scratches.push(scratch);
      const result = await prisma(scratch.url, ['migrate', 'deploy'], {
        ...TEST_ENV,
        CENTERIVO_TEST_DB_TOKEN: `another-run-${hex()}-token`,
      });
      expect(result.code).toBe(1);
      expect(result.out).toMatch(/marker token does not match/);
      expect(await tables(scratch.name)).toBe(0);
    });

    it('a partial test declaration (NODE_ENV=test only) cannot unlock even a marked database', async () => {
      const scratch = await createScratchDatabase(baseUrl, 'guard_partial');
      scratches.push(scratch);
      const result = await prisma(scratch.url, ['migrate', 'deploy'], {
        PATH: TEST_ENV.PATH,
        HOME: TEST_ENV.HOME,
        NODE_ENV: 'test',
      });
      expect(result.code).toBe(1);
      expect(result.out).toMatch(/CENTERIVO_TEST_DATABASE must be "1"/);
      expect(await tables(scratch.name)).toBe(0);
    });

    it('a test-named database is refused even when the run forgets to declare itself a test', async () => {
      const database = `mocha_guard_${hex()}_test`;
      mustNotExist.push(database);
      const result = await prisma(
        urlFor(database),
        ['migrate', 'deploy'],
        PLAIN_ENV,
      );
      expect(result.code).toBe(1);
      expect(result.out).toMatch(REFUSED);
      expect(await exists(database)).toBe(false);
    });

    it('throwaway migration projects (createMigrationProject) carry the same guard', async () => {
      const database = `mocha_guard_${hex()}_test`;
      mustNotExist.push(database);
      const migrations = listMigrations(join(databaseDir, 'prisma/migrations'));
      const project = createMigrationProject(
        join(databaseDir, 'prisma/migrations'),
        migrations.slice(0, 1).map((m) => m.name),
      );
      projects.push(project);
      const result = await prisma(urlFor(database), [
        'migrate',
        'deploy',
        '--config',
        project.config,
      ]);
      expect(result.code).toBe(1);
      expect(result.out).toMatch(REFUSED);
      expect(await exists(database)).toBe(false);
    });

    it('the seed script run directly (tsx, no Prisma CLI) refuses an unmarked test database', async () => {
      const database = `mocha_guard_${hex()}_test`;
      await createUnmarked(database);
      const result = await run(tsxBin, ['prisma/seed.ts'], {
        ...TEST_ENV,
        DATABASE_URL: urlFor(database),
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(REFUSED);
      expect(await tables(database)).toBe(0);
    });

    it('refusals never print the connection string, user or password', async () => {
      const database = `mocha_guard_${hex()}_test`;
      mustNotExist.push(database);
      const url = new URL(urlFor(database));
      const result = await prisma(url.toString(), ['migrate', 'deploy']);
      expect(result.code).toBe(1);
      expect(result.out).not.toContain(url.toString());
      if (url.password) expect(result.out).not.toContain(url.password);
      expect(result.out).not.toContain(`${url.username}:`);
    });
  });

  describe('legitimate workflows keep working', () => {
    it('a marked disposable database: migrate deploy and seed succeed', async () => {
      const scratch = await createScratchDatabase(baseUrl, 'guard_ok');
      scratches.push(scratch);
      const migrate = await prisma(scratch.url, ['migrate', 'deploy']);
      expect([migrate.code, migrate.out]).toEqual([
        0,
        expect.stringMatching(/applied/),
      ]);
      const seed = await prisma(scratch.url, ['db', 'seed']);
      expect(seed.code).toBe(0);
      expect(await tables(scratch.name)).toBeGreaterThan(10);
    });

    it('commands that never touch a database run in a test environment without one', async () => {
      const database = `mocha_guard_${hex()}_test`;
      mustNotExist.push(database);
      const result = await prisma(urlFor(database), ['validate']);
      expect(result.code).toBe(0);
      expect(await exists(database)).toBe(false);
    });

    it('an ordinary non-test run against a non-test database is not affected (how real environments are migrated)', async () => {
      // Stands in for a development or deployment database on this
      // disposable server; created and dropped by this spec.
      const database = `centerivo_guard_plain_${hex()}`;
      await createUnmarked(database);
      const result = await prisma(
        urlFor(database),
        ['migrate', 'deploy'],
        PLAIN_ENV,
      );
      expect([result.code, result.out]).toEqual([
        0,
        expect.stringMatching(/applied/),
      ]);
      expect(await tables(database)).toBeGreaterThan(10);
    });
  });
});
