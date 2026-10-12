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

// How Prisma Migrate (7.x, PostgreSQL) executes a migration script —
// verified from the server's statement log (Security 4C-2):
//   - a script that contains dollar-quoting (`$`, e.g. a DO block) is sent
//     as ONE simple-protocol query, which Postgres runs as a single implicit
//     transaction: any failing statement rolls back the whole file;
//   - every other script is split into its individual statements, each sent
//     and auto-committed on its own, stopping at the first failure: the
//     statements before it STAY APPLIED.
// applyMigrationSql reproduces exactly that, so scratch-database tests see
// the same partial state a real deploy would. (Earlier versions sent every
// dollar-free script as one query and so over-stated its atomicity.)
export function isAppliedAtomically(sql: string): boolean {
  return sql.includes("$") || splitSqlStatements(sql).length <= 1;
}

export async function applyMigrationSql(
  url: string,
  sql: string,
): Promise<void> {
  if (sql.includes("$")) {
    await withClient(url, (client) => client.query(sql));
    return;
  }
  const statements = splitSqlStatements(sql);
  await withClient(url, async (client) => {
    for (const statement of statements) {
      await client.query(statement);
    }
  });
}

// Splits a dollar-free SQL script into statements on top-level semicolons,
// ignoring semicolons inside '...' strings, "..." identifiers and -- / /* */
// comments. Comment-only fragments are dropped.
export function splitSqlStatements(sql: string): string[] {
  if (sql.includes("$")) {
    throw new Error("splitSqlStatements does not handle dollar-quoted SQL.");
  }
  const statements: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      current += sql.slice(i, stop);
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      current += sql.slice(i, stop);
      i = stop;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j += 1;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === ";") {
      statements.push(current);
      current = "";
      i += 1;
    } else {
      current += ch;
      i += 1;
    }
  }
  statements.push(current);
  return statements
    .map((statement) => statement.trim())
    .filter(
      (statement) =>
        statement
          .replace(/--.*$/gm, "")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .trim().length > 0,
    );
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
