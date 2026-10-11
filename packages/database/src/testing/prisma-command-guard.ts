import {
  TEST_DATABASE_FLAG_ENV,
  TEST_DATABASE_TOKEN_ENV,
  assertMarkedDisposableDatabase,
  isTestDatabaseName,
} from "./disposable-database";

// Security follow-up F-1 — the disposable-database guard, enforced by the
// Prisma CLI itself.
//
// `prisma migrate deploy` (and `migrate dev` / `reset`, `db push`) CREATES the
// database its URL names when it does not exist. So a test workflow whose
// `db:create-disposable` step was refused — wrong name, missing token, a
// database that already exists — could still go on to create and migrate an
// UNGUARDED database if the next shell command ran anyway (`;`, a pasted
// block, a script without `set -e`). This was observed during the Security
// 4C-5 review.
//
// prisma.config.ts runs this before Prisma does anything, for every Prisma
// command that touches a database. When the run is a declared test run, or
// targets a database named like a test database, the database must already
// exist and carry this run's disposable marker (assertMarkedDisposableDatabase:
// test environment, unambiguous URL, catalog marker + token). Otherwise the
// command fails before Prisma connects — nothing is created, migrated or
// seeded, whatever the shell did before.
//
// Ordinary development and real deployments (no test declaration, a
// database not named like a test database) are not affected.
//
// Boundary — what this does NOT cover (see docs/security/ci-and-required-checks.md):
// a Prisma run with a different `--config` file, a run that declares nothing
// and targets a non-test-named database (by design: that is how real
// environments are migrated), and tools other than Prisma (psql, pg_restore).

// Prisma CLI commands that connect to (and may create or change) a database.
// `generate`, `validate`, `format`, `version` and `init` never do.
const DATABASE_COMMANDS = new Set(["migrate", "db", "studio"]);

type Env = Record<string, string | undefined>;

// argv = [node, prisma-cli, ...args]. Flags may come first and take values
// (`--config x.ts migrate deploy`), so any argument naming a database command
// counts. Erring this way only ever guards more, never less.
export function prismaCommandTouchesDatabase(argv: readonly string[]): boolean {
  return argv.slice(2).some((arg) => DATABASE_COMMANDS.has(arg));
}

// Any sign that this is a test run counts — a partial or wrong declaration
// is exactly when the guard must speak up, not stay silent.
export function declaresTestRun(env: Env): boolean {
  return (
    env[TEST_DATABASE_FLAG_ENV] !== undefined ||
    env[TEST_DATABASE_TOKEN_ENV] !== undefined ||
    env.NODE_ENV === "test"
  );
}

export function targetsTestNamedDatabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
    // Case-insensitive on purpose: `Mocha_TEST` is still meant as a test
    // database, and the guard (lower-case names only) then refuses it.
    return isTestDatabaseName(name.toLowerCase());
  } catch {
    return false;
  }
}

export function requiresDisposableDatabase(
  argv: readonly string[],
  env: Env,
  url: string | undefined,
): boolean {
  return (
    prismaCommandTouchesDatabase(argv) &&
    (declaresTestRun(env) || targetsTestNamedDatabase(url))
  );
}

// Resolves when the command may run; rejects (DisposableDatabaseError)
// otherwise.
export async function guardPrismaCommand(
  argv: readonly string[] = process.argv,
  env: Env = process.env,
  url: string | undefined = env.DATABASE_URL,
): Promise<void> {
  if (!requiresDisposableDatabase(argv, env, url)) return;
  await assertMarkedDisposableDatabase(url, env);
}

// For scripts that open their own connection instead of going through the
// Prisma CLI (prisma/seed.ts run directly with tsx): same rule, without a
// command to inspect.
export async function guardDatabaseScript(
  env: Env = process.env,
  url: string | undefined = env.DATABASE_URL,
): Promise<void> {
  if (!declaresTestRun(env) && !targetsTestNamedDatabase(url)) return;
  await assertMarkedDisposableDatabase(url, env);
}
