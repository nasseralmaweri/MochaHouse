import {
  isDeclaredTestRun,
  isLoopbackHost,
  productionSignal,
} from '@mocha-house/database';

// ESP-02 — when may development authentication be enabled?
//
// The dev auth providers sign in without a password and mint or accept tokens
// signed with a shared dev secret. They exist only for local development and
// isolated tests, so they are enabled ONLY in a positively identified safe
// context. Being "not production" is never enough: an unset or misspelt
// NODE_ENV, `staging`, or a deployment variable saying `production` must all
// keep dev auth OFF. Fail closed — the strictest signal decides.
//
//   "isolated-test"  a declared test run (CENTERIVO_TEST_DATABASE=1 with a
//                    well-formed token, NODE_ENV=test or, inside Jest,
//                    development) with no production-like signal. This is how
//                    CI and the Jest suites run; they need no further opt-in.
//   "local"          NODE_ENV=development AND the explicit opt-in
//                    ALLOW_DEV_AUTH=1 AND DATABASE_URL names a loopback host,
//                    with no production-like signal. NODE_ENV alone is never
//                    enough; neither is the opt-in on its own.
//
// Anything else — including a production-like signal in ANY of NODE_ENV,
// CENTERIVO_ENV, APP_ENV, DEPLOYMENT_ENV, ENVIRONMENT — is not a safe context.
// The same functions back the startup validation (auth-startup-guard.ts) and
// the per-request provider gates, so the two can never disagree.

type Env = Record<string, string | undefined>;

export const ALLOW_DEV_AUTH_ENV = 'ALLOW_DEV_AUTH';

export type DevAuthContext = 'isolated-test' | 'local';

function databaseIsLoopback(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'postgresql:' || parsed.protocol === 'postgres:') &&
      !parsed.host.includes(',') &&
      isLoopbackHost(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function devAuthContext(env: Env = process.env): DevAuthContext | null {
  if (productionSignal(env) !== null) return null;
  if (isDeclaredTestRun(env)) return 'isolated-test';
  if (
    env.NODE_ENV === 'development' &&
    env[ALLOW_DEV_AUTH_ENV] === '1' &&
    databaseIsLoopback(env.DATABASE_URL)
  ) {
    return 'local';
  }
  return null;
}

export function isSafeDevAuthContext(env: Env = process.env): boolean {
  return devAuthContext(env) !== null;
}

// What is missing for a safe context, for an error message. Names variables
// and requirements only — never a value.
export function devAuthContextProblems(env: Env = process.env): string[] {
  const signal = productionSignal(env);
  if (signal !== null) {
    return [`${signal} declares a production, staging or live environment.`];
  }
  if (isDeclaredTestRun(env)) return [];
  const problems: string[] = [];
  if (env.NODE_ENV !== 'development') {
    problems.push(
      'NODE_ENV must be "development" (or this must be a declared isolated test run).',
    );
  }
  if (env[ALLOW_DEV_AUTH_ENV] !== '1') {
    problems.push(
      `${ALLOW_DEV_AUTH_ENV}=1 is required for local development auth.`,
    );
  }
  if (!databaseIsLoopback(env.DATABASE_URL)) {
    problems.push('DATABASE_URL must name a loopback database host.');
  }
  return problems;
}
