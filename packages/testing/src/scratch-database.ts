import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  SCRATCH_DATABASE_PREFIX,
  assertDisposableDatabase,
  createDisposableDatabase,
  dropDisposableDatabase,
} from "./disposable-database";

// TEST-ONLY throwaway databases (Milestone S0D-1).
//
// Destructive migration / backfill tests must never run against the shared
// development database. A scratch database is created next to it (same
// server, same credentials, a unique `mh_scratch_*` name), migrated to
// exactly the state a test needs, and dropped afterwards.

export interface ScratchDatabase {
  readonly name: string;
  // A connection string for the scratch database (same user/host as base).
  readonly url: string;
  drop(): Promise<void>;
}

async function withClient<T>(
  url: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Creates an empty scratch database on the server `baseUrl` points at.
// `label` only makes the name recognisable; uniqueness comes from random
// bytes, so parallel/aborted runs never collide.
//
// Security 4C-1 — only next to a database proven disposable (see
// assertDisposableDatabase), and the scratch database is itself created
// and marked disposable by this process; `drop()` removes only a database
// this process created and that still carries this run's marker.
export async function createScratchDatabase(
  baseUrl: string,
  label: string,
): Promise<ScratchDatabase> {
  await assertDisposableDatabase(baseUrl);
  const safeLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 24);
  const name = `${SCRATCH_DATABASE_PREFIX}${safeLabel}_${randomBytes(4).toString("hex")}`;
  const url = await createDisposableDatabase(baseUrl, name);

  return {
    name,
    url,
    drop: () => dropDisposableDatabase(baseUrl, name),
  };
}

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

// Every migration folder under `migrationsDir`, in the order Prisma applies
// them (lexical by timestamped folder name).
export function listMigrations(migrationsDir: string): MigrationFile[] {
  return readdirSync(migrationsDir)
    .filter((entry) => statSync(join(migrationsDir, entry)).isDirectory())
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"),
    }));
}

const ENUM_VALUE_ADDITION = /ALTER TYPE\s+"?\w+"?\s+ADD VALUE/i;

// Applies one migration script the way Prisma Migrate (7.x, PostgreSQL)
// does — verified from the server's statement log during S0D-1:
//   - normally the WHOLE file is sent as ONE simple-protocol query, which
//     Postgres runs as a single implicit transaction: a failing statement
//     (e.g. a RAISE EXCEPTION guard) rolls back every statement in the file;
//   - a file containing `ALTER TYPE ... ADD VALUE` is instead sent one
//     statement at a time (each autocommitted), because Postgres cannot use
//     a new enum value inside the transaction that added it.
// The split path supports only files without dollar-quoted bodies (true of
// every enum-adding migration in this repository); anything else is
// refused rather than split incorrectly.
export async function applyMigrationSql(
  url: string,
  sql: string,
): Promise<void> {
  if (!ENUM_VALUE_ADDITION.test(sql)) {
    await withClient(url, (client) => client.query(sql));
    return;
  }
  if (sql.includes("$")) {
    throw new Error(
      "applyMigrationSql cannot split an enum-adding migration that contains dollar-quoted SQL.",
    );
  }
  const statements = sql
    .split(/;\s*$/m)
    .map((statement) => statement.trim())
    .filter((statement) => statement.replace(/--.*$/gm, "").trim().length > 0);
  await withClient(url, async (client) => {
    for (const statement of statements) {
      await client.query(statement);
    }
  });
}

// True when Prisma applies `sql` as one atomic unit (see applyMigrationSql).
export function isAppliedAtomically(sql: string): boolean {
  return !ENUM_VALUE_ADDITION.test(sql);
}

export async function applyMigrations(
  url: string,
  migrations: readonly MigrationFile[],
): Promise<void> {
  for (const migration of migrations) {
    await applyMigrationSql(url, migration.sql);
  }
}

// Runs a callback with a connected client to the scratch database.
export function withScratchClient<T>(
  url: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  return withClient(url, fn);
}
