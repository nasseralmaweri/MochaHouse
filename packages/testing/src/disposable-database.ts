import { timingSafeEqual } from "node:crypto";
import { Client } from "pg";

// Security 4C-1 — TEST-ONLY proof that a database is disposable.
//
// Destructive and data-mutating tests (and the scratch-database helpers
// they use) must only ever touch a database that was CREATED for testing.
// No single signal is trusted on its own — a hostname, a database name, an
// environment variable or a marker can each be wrong or copied — so
// `assertDisposableDatabase` requires ALL of these, independently:
//
//   1. The process declares itself a test run: CENTERIVO_TEST_DATABASE=1, a
//      well-formed CENTERIVO_TEST_DB_TOKEN, NODE_ENV=test (or "development"
//      only inside a Jest test process, where existing suites select the
//      dev auth providers that way), and nothing declares a production /
//      staging environment.
//   2. The connection string is unambiguous: a single PostgreSQL host, a
//      database name matching the test naming pattern, no connection
//      `options` that could override server settings, and no second
//      database URL in the environment naming a different database.
//   3. The database itself carries the disposable marker, read from the
//      server catalog (pg_db_role_setting, database-wide entries only), not
//      from the session: both the marker's database name and its token
//      must match. Role-level settings and connection options cannot fake
//      it, and `CREATE DATABASE ... TEMPLATE` copies do not inherit it. The
//      marker is only ever written by `createDisposableDatabase`, onto a
//      database it has JUST created — never onto an existing one.
//
//      The marker alone is NOT proof of safety: `pg_dump --create` emits
//      database-level settings (`ALTER DATABASE ... SET`), so restoring
//      such a dump recreates the marker under the original name, and any
//      database owner can set it deliberately. It also says nothing about
//      the data inside. That is why it is one of four independent checks.
//   4. Every business (Tenant row) in it is an approved fictional test
//      identity, and no identity is ambiguous (a known id with a different
//      slug, or a known slug under a different id).
//
// Failures throw DisposableDatabaseError naming the failed check. Messages
// never include the connection string, user, password, host or any row
// data beyond the (fictional) tenant identities being rejected.

export const TEST_DATABASE_FLAG_ENV = "CENTERIVO_TEST_DATABASE";
export const TEST_DATABASE_TOKEN_ENV = "CENTERIVO_TEST_DB_TOKEN";
export const DISPOSABLE_TOKEN_SETTING = "centerivo.disposable_token";
export const DISPOSABLE_NAME_SETTING = "centerivo.disposable_database";
export const SCRATCH_DATABASE_PREFIX = "mh_scratch_";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
// Lower-case identifiers only, and the name must say it is a test database:
// a `test` or `ci` segment, or the scratch prefix.
const DATABASE_NAME_PATTERN = /^[a-z0-9_]{1,63}$/;
const TEST_SEGMENT_PATTERN = /(^|_)(test|ci)(_|$)/;
const PRODUCTION_ENV_VARS = [
  "CENTERIVO_ENV",
  "APP_ENV",
  "DEPLOYMENT_ENV",
  "ENVIRONMENT",
] as const;
const PRODUCTION_VALUES = new Set(["production", "prod", "staging", "live"]);
const SECOND_DATABASE_URL_ENVS = [
  "DIRECT_URL",
  "DIRECT_DATABASE_URL",
  "SHADOW_DATABASE_URL",
] as const;
const MAX_TEST_TENANTS = 25;

// The fictional businesses test suites create. Mocha House (Tenant #1) is
// seeded into every test database with the same id production uses, which
// is exactly why identity alone never proves a database is disposable.
const MOCHA_HOUSE_ID = "01a0db02-f800-7000-8000-000000000001";
const MOCHA_HOUSE_SLUG = "mocha-house";
// Every other test business uses a visibly-test id ("7e57").
const TEST_TENANT_ID_PATTERN = /^01a0db02-f800-7000-8000-7e57[0-9a-f]{8}$/;

export class DisposableDatabaseError extends Error {
  constructor(
    readonly check: string,
    detail: string,
  ) {
    super(
      `Refusing to use this database for destructive tests (${check}): ${detail}`,
    );
    this.name = "DisposableDatabaseError";
  }
}

type Env = Record<string, string | undefined>;

export interface DisposableDatabaseIdentity {
  readonly database: string;
  readonly tenantCount: number;
}

function refuse(check: string, detail: string): never {
  throw new DisposableDatabaseError(check, detail);
}

// Check 1 — the process is a declared test run. Returns the token.
export function assertTestEnvironment(env: Env = process.env): string {
  // Suites that exercise the dev auth providers set NODE_ENV=development
  // inside their Jest process; that is accepted only when Jest itself
  // (JEST_WORKER_ID) is running the code. Anywhere else NODE_ENV must be
  // exactly "test". Production is refused below in every case.
  const nodeEnv = env.NODE_ENV;
  const insideJest = typeof env.JEST_WORKER_ID === "string";
  if (nodeEnv !== "test" && !(nodeEnv === "development" && insideJest)) {
    refuse(
      "environment",
      'NODE_ENV must be "test" ("development" is accepted only inside a Jest test process).',
    );
  }
  for (const name of PRODUCTION_ENV_VARS) {
    const value = env[name]?.trim().toLowerCase();
    if (value && PRODUCTION_VALUES.has(value)) {
      refuse("environment", `${name} declares a ${value} environment.`);
    }
  }
  if (env[TEST_DATABASE_FLAG_ENV] !== "1") {
    refuse("environment", `${TEST_DATABASE_FLAG_ENV} must be "1".`);
  }
  const token = env[TEST_DATABASE_TOKEN_ENV];
  if (!token || !TOKEN_PATTERN.test(token)) {
    refuse(
      "environment",
      `${TEST_DATABASE_TOKEN_ENV} must be 16-128 characters of [A-Za-z0-9_-].`,
    );
  }
  return token;
}

export function isTestDatabaseName(name: string): boolean {
  return (
    DATABASE_NAME_PATTERN.test(name) &&
    (name.startsWith(SCRATCH_DATABASE_PREFIX) ||
      TEST_SEGMENT_PATTERN.test(name))
  );
}

function databaseNameOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

// Check 2 — the connection string is a single, unambiguous test database.
export function assertUnambiguousTestUrl(
  url: string | undefined,
  env: Env = process.env,
): string {
  if (!url) {
    refuse("connection", "no database URL is configured.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    refuse("connection", "the database URL is not a valid URL.");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    refuse("connection", "the database URL is not a PostgreSQL URL.");
  }
  if (!parsed.hostname || parsed.host.includes(",")) {
    refuse("connection", "the database URL must name exactly one host.");
  }
  for (const key of parsed.searchParams.keys()) {
    if (key.toLowerCase() === "options") {
      refuse(
        "connection",
        "connection `options` are not allowed: they can override server settings.",
      );
    }
  }
  if (env.PGOPTIONS) {
    refuse("connection", "PGOPTIONS is set: it can override server settings.");
  }
  const database = databaseNameOf(url);
  if (!database || !isTestDatabaseName(database)) {
    refuse(
      "connection",
      "the database name must be lower-case and contain a `test` or `ci` segment (or be a scratch database).",
    );
  }
  for (const name of SECOND_DATABASE_URL_ENVS) {
    const other = env[name];
    if (other && databaseNameOf(other) !== database) {
      refuse(
        "connection",
        `${name} names a different database than the one under test.`,
      );
    }
  }
  return database;
}

async function withClient<T>(
  url: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
  } catch {
    // The driver's message can echo connection details; replace it.
    refuse("connection", "could not connect to the database.");
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function tokensMatch(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The disposable marker as stored in the server catalog for THIS database
// (database-level settings, role = any). Session `SET`s and connection
// options cannot fake it.
async function readMarker(
  client: Client,
): Promise<{ database: string; marker: Map<string, string> }> {
  const { rows } = await client.query<{
    database: string;
    setconfig: string[] | null;
  }>(
    `SELECT current_database() AS database,
            (SELECT s.setconfig FROM pg_db_role_setting s
               JOIN pg_database d ON d.oid = s.setdatabase
              WHERE d.datname = current_database() AND s.setrole = 0) AS setconfig`,
  );
  const marker = new Map<string, string>();
  for (const entry of rows[0]?.setconfig ?? []) {
    const eq = entry.indexOf("=");
    if (eq > 0) marker.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return { database: rows[0]?.database ?? "", marker };
}

function assertMarker(
  expectedDatabase: string,
  token: string,
  actual: { database: string; marker: Map<string, string> },
): void {
  if (actual.database !== expectedDatabase) {
    refuse(
      "marker",
      "the server reports a different database than the URL names.",
    );
  }
  const markedName = actual.marker.get(DISPOSABLE_NAME_SETTING);
  const markedToken = actual.marker.get(DISPOSABLE_TOKEN_SETTING);
  if (markedName === undefined || markedToken === undefined) {
    refuse(
      "marker",
      "the database carries no disposable marker. Create test databases with createDisposableDatabase (pnpm --filter @mocha-house/testing db:create-disposable); existing databases are never marked.",
    );
  }
  if (markedName !== actual.database) {
    refuse(
      "marker",
      "the disposable marker was written for a different database.",
    );
  }
  if (!tokensMatch(token, markedToken)) {
    refuse(
      "marker",
      `the disposable marker token does not match ${TEST_DATABASE_TOKEN_ENV}.`,
    );
  }
}

// Check 4 — only approved, unambiguous fictional businesses.
export function assertApprovedTestTenants(
  tenants: ReadonlyArray<{ id: string; slug: string }>,
): void {
  if (tenants.length > MAX_TEST_TENANTS) {
    refuse(
      "identity",
      `the database holds ${tenants.length} businesses; a test database holds at most ${MAX_TEST_TENANTS}.`,
    );
  }
  for (const tenant of tenants) {
    if (tenant.id === MOCHA_HOUSE_ID) {
      if (tenant.slug !== MOCHA_HOUSE_SLUG) {
        refuse(
          "identity",
          "the Tenant #1 id is attached to an unexpected slug.",
        );
      }
      continue;
    }
    if (tenant.slug === MOCHA_HOUSE_SLUG) {
      refuse(
        "identity",
        "the Mocha House slug is attached to an unexpected id.",
      );
    }
    if (!TEST_TENANT_ID_PATTERN.test(tenant.id)) {
      refuse(
        "identity",
        `business ${tenant.id} is not an approved fictional test business.`,
      );
    }
  }
}

async function readTenants(
  client: Client,
): Promise<Array<{ id: string; slug: string }>> {
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public."Tenant"') IS NOT NULL AS present`,
  );
  if (!rows[0]?.present) return [];
  const tenants = await client.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM "Tenant" ORDER BY id LIMIT ${MAX_TEST_TENANTS + 1}`,
  );
  return tenants.rows;
}

export async function assertDisposableDatabase(
  url: string | undefined = process.env.DATABASE_URL,
  env: Env = process.env,
): Promise<DisposableDatabaseIdentity> {
  const token = assertTestEnvironment(env);
  const database = assertUnambiguousTestUrl(url, env);
  return withClient(url!, async (client) => {
    assertMarker(database, token, await readMarker(client));
    const tenants = await readTenants(client);
    assertApprovedTestTenants(tenants);
    return { database, tenantCount: tenants.length };
  });
}

// Marker check only (no tenant identities) — for scratch databases whose
// fixtures deliberately contain arbitrary businesses.
async function assertMarkedDatabase(url: string, env: Env): Promise<string> {
  const token = assertTestEnvironment(env);
  const database = assertUnambiguousTestUrl(url, env);
  await withClient(url, async (client) =>
    assertMarker(database, token, await readMarker(client)),
  );
  return database;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quoteIdent(name: string): string {
  if (!DATABASE_NAME_PATTERN.test(name)) {
    refuse("connection", "unsafe database identifier.");
  }
  return `"${name}"`;
}

// Databases this process created — the only ones it may ever drop.
const createdByThisProcess = new Set<string>();

// Creates a NEW database named `database` on the server `adminUrl` points
// at and marks it disposable. CREATE DATABASE fails if the name already
// exists, so an existing database is never marked. If marking fails the
// just-created database is dropped again.
export async function createDisposableDatabase(
  adminUrl: string,
  database: string,
  env: Env = process.env,
): Promise<string> {
  const token = assertTestEnvironment(env);
  if (!isTestDatabaseName(database)) {
    refuse(
      "connection",
      "the database name must be lower-case and contain a `test` or `ci` segment (or be a scratch database).",
    );
  }
  const name = quoteIdent(database);
  await withClient(adminUrl, async (client) => {
    try {
      await client.query(`CREATE DATABASE ${name}`);
    } catch {
      refuse(
        "create",
        `database ${database} could not be created (it may already exist; existing databases are never marked disposable).`,
      );
    }
    createdByThisProcess.add(database);
    try {
      await client.query(
        `ALTER DATABASE ${name} SET ${DISPOSABLE_NAME_SETTING} = '${database}'`,
      );
      await client.query(
        `ALTER DATABASE ${name} SET ${DISPOSABLE_TOKEN_SETTING} = '${token}'`,
      );
    } catch {
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      createdByThisProcess.delete(database);
      refuse("create", `database ${database} could not be marked disposable.`);
    }
  });
  return withDatabase(adminUrl, database);
}

// Drops a database only if THIS process created it, it is a scratch
// database, and it still carries this run's marker.
export async function dropDisposableDatabase(
  adminUrl: string,
  database: string,
  env: Env = process.env,
): Promise<void> {
  if (!createdByThisProcess.has(database)) {
    refuse(
      "cleanup",
      `database ${database} was not created by this test process.`,
    );
  }
  if (!database.startsWith(SCRATCH_DATABASE_PREFIX)) {
    refuse("cleanup", `database ${database} is not a scratch database.`);
  }
  await assertMarkedDatabase(withDatabase(adminUrl, database), env);
  await withClient(adminUrl, (client) =>
    client.query(
      `DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`,
    ),
  );
  createdByThisProcess.delete(database);
}

// Approved test-only business ids a cleanup helper may delete. Tenant #1
// (Mocha House) is never deletable by a test helper.
export function assertDeletableTestTenantId(id: string): void {
  if (!TEST_TENANT_ID_PATTERN.test(id)) {
    refuse("cleanup", `business ${id} is not a test-only business.`);
  }
}
