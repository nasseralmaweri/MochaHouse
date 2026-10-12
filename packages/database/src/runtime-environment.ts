// The one classifier of "is this a production-like environment?", shared by
// everything that must fail closed outside development: the seed guard
// (src/testing/seed-guard.ts), the API's startup validation and its
// request-time dev-auth / payment gates (apps/api/src/config).
//
// Fail closed means the STRICTEST signal decides. NODE_ENV and the four
// deployment variables below each count on their own: `NODE_ENV=development`
// with `APP_ENV=production` is a production-like environment. Values are
// trimmed and compared case-insensitively, so " Production " counts too.
//
// Only the NAME of a signalling variable is ever reported, never its value.

export type Env = Record<string, string | undefined>;

export const PRODUCTION_ENV_VARS = [
  "CENTERIVO_ENV",
  "APP_ENV",
  "DEPLOYMENT_ENV",
  "ENVIRONMENT",
] as const;

export const PRODUCTION_VALUES = new Set([
  "production",
  "prod",
  "staging",
  "live",
]);

// The name of the first variable that declares a production, staging or live
// environment, or null when none does.
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

const TEST_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

// A process that declares itself an isolated test run: CENTERIVO_TEST_DATABASE=1,
// a well-formed CENTERIVO_TEST_DB_TOKEN, and NODE_ENV=test (or "development"
// only inside a Jest worker, where existing suites select the dev auth
// providers that way). Mirrors the environment check of the disposable-
// database guard (assertTestEnvironment) without the production-signal part,
// which callers check separately; a drift test keeps the two in step. It does
// NOT prove any database is disposable — that is the marker's job.
export function isDeclaredTestRun(env: Env): boolean {
  const nodeEnv = env.NODE_ENV;
  const insideJest = typeof env.JEST_WORKER_ID === "string";
  if (nodeEnv !== "test" && !(nodeEnv === "development" && insideJest)) {
    return false;
  }
  if (env.CENTERIVO_TEST_DATABASE !== "1") return false;
  const token = env.CENTERIVO_TEST_DB_TOKEN;
  return token !== undefined && TEST_TOKEN_PATTERN.test(token);
}
