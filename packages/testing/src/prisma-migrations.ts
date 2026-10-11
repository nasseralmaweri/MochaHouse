import { execFile } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";

// TEST-ONLY harness for running migrations with the REAL Prisma CLI
// (`prisma migrate deploy` / `resolve` / `diff`) against scratch databases —
// the way CI and every environment apply them — instead of approximating
// Prisma's execution (Security 4C-2/4C-3).

export interface PrismaResult {
  readonly code: number;
  readonly out: string;
}

// A datasource-only schema: enough for `migrate deploy` / `resolve`, which
// only read the migrations folder. Schema-vs-database comparisons use the
// repository's own schema, or a catalog comparison between databases.
export const MINIMAL_PRISMA_SCHEMA =
  'datasource db {\n  provider = "postgresql"\n}\n';

// Runs the Prisma CLI of `databaseDir` (packages/database). Without
// `config`, the repository's own prisma.config.ts is used.
export function prismaCli(databaseDir: string) {
  const bin = join(databaseDir, "node_modules/.bin/prisma");
  return async (
    url: string,
    args: readonly string[],
    config?: string,
  ): Promise<PrismaResult> => {
    const run = promisify(execFile);
    return run(bin, [...args, ...(config ? ["--config", config] : [])], {
      cwd: databaseDir,
      env: { ...process.env, DATABASE_URL: url },
      timeout: 180_000,
    }).then(
      (r) => ({ code: 0, out: `${r.stdout}${r.stderr}` }),
      (e: { code?: number; stdout?: string; stderr?: string }) => ({
        code: typeof e.code === "number" ? e.code : 1,
        out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
      }),
    );
  };
}

export interface MigrationProject {
  readonly config: string;
  remove(): void;
}

export interface ExtraMigration {
  readonly name: string;
  readonly sql: string;
}

// A throwaway Prisma project holding copies of the named migrations from
// `migrationsDir` (in order), plus optional extra migrations appended after
// them (e.g. a rollback shipped as a forward migration).
export function createMigrationProject(
  migrationsDir: string,
  names: readonly string[],
  extra?: ExtraMigration | readonly ExtraMigration[],
  schema: string = MINIMAL_PRISMA_SCHEMA,
): MigrationProject {
  const dir = mkdtempSync(join(tmpdir(), "mh-prisma-project-"));
  const target = join(dir, "migrations");
  mkdirSync(target);
  for (const name of names) {
    cpSync(join(migrationsDir, name), join(target, name), { recursive: true });
  }
  copyFileSync(
    join(migrationsDir, "migration_lock.toml"),
    join(target, "migration_lock.toml"),
  );
  const extras: readonly ExtraMigration[] =
    extra === undefined ? [] : "name" in extra ? [extra] : extra;
  for (const { name, sql } of extras) {
    mkdirSync(join(target, name));
    writeFileSync(join(target, name, "migration.sql"), sql);
  }
  writeFileSync(join(dir, "schema.prisma"), schema);
  const config = join(dir, "prisma.config.ts");
  writeFileSync(
    config,
    `export default { schema: ${JSON.stringify(join(dir, "schema.prisma"))}, migrations: { path: ${JSON.stringify(target)} }, datasource: { url: process.env["DATABASE_URL"] } };\n`,
  );
  return {
    config,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface DatabaseCatalog {
  readonly indexes: readonly string[];
  readonly constraints: readonly string[];
  readonly triggers: readonly string[];
  readonly functions: readonly string[];
}

// Every index, constraint, (user) trigger and function definition in the
// public schema — for comparing two databases' structure exactly.
export async function databaseCatalog(url: string): Promise<DatabaseCatalog> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const indexes = await client.query<{ d: string }>(
      `SELECT indexdef AS d FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
    );
    const constraints = await client.query<{ d: string }>(
      `SELECT c.conrelid::regclass::text || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid) AS d
         FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public' ORDER BY 1`,
    );
    const triggers = await client.query<{ d: string }>(
      `SELECT pg_get_triggerdef(t.oid) AS d
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
        ORDER BY 1`,
    );
    const functions = await client.query<{ d: string }>(
      `SELECT pg_get_functiondef(p.oid) AS d
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        ORDER BY 1`,
    );
    return {
      indexes: indexes.rows.map((r) => r.d),
      constraints: constraints.rows.map((r) => r.d),
      triggers: triggers.rows.map((r) => r.d),
      functions: functions.rows.map((r) => r.d),
    };
  } finally {
    await client.end();
  }
}
