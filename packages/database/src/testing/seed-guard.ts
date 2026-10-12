import {
  PRODUCTION_ENV_VARS,
  PRODUCTION_VALUES,
  assertMarkedDisposableDatabase,
} from "./disposable-database";
import {
  declaresTestRun,
  targetsTestNamedDatabase,
} from "./prisma-command-guard";

// Seed safety (audit DB2-1 / DB2-2) — the guard prisma/seed.ts runs before it
// touches anything.
//
// The seed is development and test bootstrap data: demo locations, a demo
// menu, a local-dev administrator that signs in without a password, and
// built-in roles. It must never run against a production, staging or live
// database, and it must never be what silently reverts HQ's own changes.
//
// Fail closed. The seed proceeds only when ALL of these hold:
//   1. No production signal: NODE_ENV and the four deployment variables the
//      disposable-database guard already knows about are not production,
//      prod, staging or live.
//   2. The target is unambiguous: one PostgreSQL host, no connection
//      `options`, no PGOPTIONS, and any DIRECT_URL / SHADOW_DATABASE_URL names
//      the same host and database.
//   3. EITHER the run declares itself a test run (or the database is named
//      like a test database) AND the database proves it is disposable (the
//      catalog marker and token, via assertMarkedDisposableDatabase), OR the
//      host is a loopback address ("local" mode).
//
// "Local" mode is the ordinary development database. A loopback host is not
// proof that the database is disposable (a tunnel or port-forward makes any
// database look local), so local mode never authorises destructive work:
//   - SEED_RESET=1 (restore every seeded default, delete the seeded override
//     rows, prune role permissions) requires a verified disposable database;
//   - the local-dev administrator is created in a disposable database, and in
//     local mode only on the explicit opt-in SEED_DEV_ADMIN=1.
//
// Errors name the failed check, never the connection string, user, password
// or host.

type Env = Record<string, string | undefined>;

export const SEED_RESET_ENV = "SEED_RESET";
export const SEED_DEV_ADMIN_ENV = "SEED_DEV_ADMIN";

const SECOND_DATABASE_URL_ENVS = [
  "DIRECT_URL",
  "DIRECT_DATABASE_URL",
  "SHADOW_DATABASE_URL",
] as const;

export class SeedRefusedError extends Error {
  constructor(
    readonly check: string,
    detail: string,
  ) {
    super(`Refusing to run the development seed (${check}): ${detail}`);
    this.name = "SeedRefusedError";
  }
}

function refuse(check: string, detail: string): never {
  throw new SeedRefusedError(check, detail);
}

export type SeedMode = "disposable" | "local";

export interface SeedSafety {
  readonly mode: SeedMode;
  readonly database: string;
  // Restore every seeded default (SEED_RESET=1, disposable databases only).
  readonly reset: boolean;
  // Create the local-dev administrator.
  readonly devAdmin: boolean;
}

// The name of the first production signal, or null. Only the VARIABLE name is
// ever reported, never its value.
export function productionSignal(env: Env): string | null {
  const nodeEnv = env.NODE_ENV?.trim().toLowerCase();
  if (nodeEnv && PRODUCTION_VALUES.has(nodeEnv)) return "NODE_ENV";
  for (const name of PRODUCTION_ENV_VARS) {
    const value = env[name]?.trim().toLowerCase();
    if (value && PRODUCTION_VALUES.has(value)) return name;
  }
  return null;
}

// localhost, 127.0.0.0/8 and ::1 only. The WHATWG URL parser lower-cases the
// host and keeps IPv6 literals in brackets.
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function parseTarget(
  url: string | undefined,
  env: Env,
): { host: string; database: string } {
  if (!url) refuse("connection", "no database URL is configured.");
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
      refuse("connection", "connection `options` are not allowed.");
    }
  }
  if (env.PGOPTIONS) {
    refuse("connection", "PGOPTIONS is set: it can override server settings.");
  }
  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    refuse("connection", "the database name is not valid.");
  }
  if (!database) refuse("connection", "the database URL names no database.");

  for (const name of SECOND_DATABASE_URL_ENVS) {
    const other = env[name];
    if (!other) continue;
    let otherUrl: URL;
    try {
      otherUrl = new URL(other);
    } catch {
      refuse("connection", `${name} is not a valid URL.`);
    }
    if (
      otherUrl.host !== parsed.host ||
      decodeURIComponent(otherUrl.pathname.replace(/^\//, "")) !== database
    ) {
      refuse(
        "connection",
        `${name} names a different database than DATABASE_URL.`,
      );
    }
  }
  return { host: parsed.hostname, database };
}

// Everything that can be decided without connecting. Throws SeedRefusedError.
export function classifySeedTarget(
  env: Env,
  url: string | undefined,
): { mode: SeedMode; database: string } {
  const signal = productionSignal(env);
  if (signal) {
    refuse(
      "environment",
      `${signal} declares a production, staging or live environment.`,
    );
  }
  const { host, database } = parseTarget(url, env);
  if (declaresTestRun(env) || targetsTestNamedDatabase(url)) {
    return { mode: "disposable", database };
  }
  if (!isLoopbackHost(host)) {
    refuse(
      "connection",
      "the database is not a loopback address and is not a verified disposable test database.",
    );
  }
  return { mode: "local", database };
}

// Resolves with how the seed may run; rejects otherwise. A "disposable" target
// must also prove it (marker + token) before this resolves.
export async function assertSeedSafe(
  env: Env = process.env,
  url: string | undefined = env.DATABASE_URL,
): Promise<SeedSafety> {
  const { mode, database } = classifySeedTarget(env, url);
  if (mode === "disposable") {
    await assertMarkedDisposableDatabase(url, env);
  }

  const resetValue = env[SEED_RESET_ENV];
  if (resetValue !== undefined && resetValue !== "" && resetValue !== "0") {
    if (resetValue !== "1") {
      refuse("reset", `${SEED_RESET_ENV} must be 1 (or unset).`);
    }
    if (mode !== "disposable") {
      refuse(
        "reset",
        `${SEED_RESET_ENV}=1 is only allowed on a verified disposable test database.`,
      );
    }
  }
  const reset = resetValue === "1";

  const devAdmin =
    mode === "disposable" ||
    (mode === "local" && env[SEED_DEV_ADMIN_ENV] === "1");

  return { mode, database, reset, devAdmin };
}
