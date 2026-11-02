import { productionSignal } from '@mocha-house/database';
import {
  ALLOW_DEV_AUTH_ENV,
  devAuthContext,
  devAuthContextProblems,
} from './dev-auth-context';

// ESP-02 — fail-closed startup validation of the authentication (and payment
// simulation) configuration. main.ts runs this BEFORE NestFactory.create, so an
// unsafe configuration never reaches a point where it accepts a request. The
// request-time provider gates (isDevInternalAuthEnabled / isDevCustomerAuthEnabled
// and resolvePaymentProviderMode) use the same classifier, so they cannot
// disagree with this check.
//
// What it refuses (every problem is reported at once; messages name variables
// and requirements, never a value or a secret):
//   - A mode variable (AUTH_PROVIDER, INTERNAL_AUTH_PROVIDER,
//     PLATFORM_AUTH_PROVIDER) that is not exactly "cognito", "dev" or unset.
//     A typo such as "Dev" would otherwise silently select Cognito.
//   - Development auth requested outside a verified safe context (see
//     dev-auth-context.ts): any production-like signal, an unset or unknown
//     NODE_ENV, a missing ALLOW_DEV_AUTH=1 opt-in, or a non-loopback database.
//   - ALLOW_DEV_AUTH set to anything but 1 or unset, or set at all in a
//     production-like environment.
//   - In a production-like environment: any dev JWT secret still present (even
//     with Cognito selected — it means a copied dev configuration and the mode
//     could flip), PAYMENT_PROVIDER=fake, and missing Cognito pool / client ids
//     (otherwise auth only fails at the first request).
//   - Dev requested with a missing, short, repeated-character or placeholder
//     secret — including the public CI values — and the same secret used for
//     any two boundaries. This applies in EVERY safe
//     context, a declared test run included: a "test run" is only environment
//     variables, so a server started with a copied CI environment (NODE_ENV=test,
//     the test flag and token, the secrets published in the repository) must
//     not pass. CI and the Jest suites never boot the API through main.ts, and
//     the request-time gates (which Jest uses) do not look at secrets, so they
//     keep working with the placeholder values.
//   - SC1a: a platform Cognito pool / app client that is set without its
//     pair, or that reuses the customer or staff pool or client. (The
//     platform pool itself is optional at startup: the platform routes fail
//     closed with 503 until it is configured.)

type Env = Record<string, string | undefined>;

export class AuthConfigurationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `Refusing to start: unsafe authentication configuration.\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
    );
    this.name = 'AuthConfigurationError';
  }
}

const BOUNDARIES = [
  { mode: 'AUTH_PROVIDER', secret: 'AUTH_DEV_JWT_SECRET' },
  { mode: 'INTERNAL_AUTH_PROVIDER', secret: 'INTERNAL_AUTH_DEV_JWT_SECRET' },
  // SC1a — the CENTERIVO platform-operator boundary.
  { mode: 'PLATFORM_AUTH_PROVIDER', secret: 'PLATFORM_AUTH_DEV_JWT_SECRET' },
] as const;

// SC1a — each boundary's Cognito pool and app client. The platform pool is
// NOT required at startup (the platform routes answer 503 until it is
// configured, which never affects a tenant route), but when it is set it
// must be complete and must not reuse the customer or staff pool or client.
const COGNITO_POOLS = [
  { pool: 'COGNITO_USER_POOL_ID', client: 'COGNITO_CLIENT_ID' },
  {
    pool: 'INTERNAL_COGNITO_USER_POOL_ID',
    client: 'INTERNAL_COGNITO_CLIENT_ID',
  },
  {
    pool: 'PLATFORM_COGNITO_USER_POOL_ID',
    client: 'PLATFORM_COGNITO_CLIENT_ID',
  },
] as const;

const COGNITO_VARS = [
  'COGNITO_USER_POOL_ID',
  'COGNITO_CLIENT_ID',
  'INTERNAL_COGNITO_USER_POOL_ID',
  'INTERNAL_COGNITO_CLIENT_ID',
] as const;

// SC1b — dev-only settings of the local platform sign-in provider (its TOTP
// secret, optional password, and enrolment switch). Never in production.
const PLATFORM_DEV_SIGN_IN_VARS = [
  'PLATFORM_AUTH_DEV_TOTP_SECRET',
  'PLATFORM_AUTH_DEV_PASSWORD',
  'PLATFORM_AUTH_DEV_MFA_ENROLLMENT',
] as const;

const MIN_DEV_SECRET_LENGTH = 32;
const PLACEHOLDER_SECRETS = new Set([
  'changeme',
  'change-me',
  'secret',
  'password',
  'dev',
  'test',
  'example',
  'default',
]);

const isSet = (env: Env, name: string) => (env[name] ?? '').trim() !== '';

function weakSecretReason(secret: string): string | null {
  const trimmed = secret.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed.length < MIN_DEV_SECRET_LENGTH) {
    return `must be at least ${MIN_DEV_SECRET_LENGTH} characters`;
  }
  if (/^(.)\1*$/.test(trimmed))
    return 'must not be a single repeated character';
  if (
    PLACEHOLDER_SECRETS.has(lower) ||
    lower.startsWith('ci-') ||
    lower.includes('not-a-real')
  ) {
    return 'must not be a placeholder or a value published in the repository';
  }
  return null;
}

export function authConfigProblems(env: Env = process.env): string[] {
  const problems: string[] = [];
  const signal = productionSignal(env);
  const productionLike = signal !== null;
  const context = devAuthContext(env);

  const devRequested: (typeof BOUNDARIES)[number][] = [];
  for (const boundary of BOUNDARIES) {
    const value = env[boundary.mode];
    if (value === 'dev') {
      devRequested.push(boundary);
    } else if (value !== undefined && value !== '' && value !== 'cognito') {
      problems.push(
        `${boundary.mode} must be exactly "cognito" or "dev" (or unset for cognito).`,
      );
    }
  }

  const allowDevAuth = env[ALLOW_DEV_AUTH_ENV];
  if (
    allowDevAuth !== undefined &&
    allowDevAuth !== '' &&
    allowDevAuth !== '0'
  ) {
    if (allowDevAuth !== '1') {
      problems.push(`${ALLOW_DEV_AUTH_ENV} must be 1 (or unset).`);
    } else if (productionLike) {
      problems.push(
        `${ALLOW_DEV_AUTH_ENV} must not be set in a production-like environment (${signal}).`,
      );
    }
  }

  if (devRequested.length > 0 && context === null) {
    problems.push(
      `Development authentication (${devRequested
        .map((boundary) => boundary.mode)
        .join(
          ', ',
        )}=dev) is not allowed here: ${devAuthContextProblems(env).join(' ')}`,
    );
  }

  if (productionLike) {
    for (const boundary of BOUNDARIES) {
      if (isSet(env, boundary.secret)) {
        problems.push(
          `${boundary.secret} must not be set in a production-like environment (${signal}).`,
        );
      }
    }
    // SC1b — the dev platform sign-in's second factor and switches.
    for (const name of PLATFORM_DEV_SIGN_IN_VARS) {
      if (isSet(env, name)) {
        problems.push(
          `${name} must not be set in a production-like environment (${signal}).`,
        );
      }
    }
    // ESP-04 M2 — both simulated providers (one-step and two-step).
    const paymentProvider = (env.PAYMENT_PROVIDER ?? '').trim().toLowerCase();
    if (paymentProvider === 'fake' || paymentProvider === 'fake-two-step') {
      problems.push(
        `PAYMENT_PROVIDER=${paymentProvider} is not allowed in a production-like environment (${signal}).`,
      );
    }
    const missing = COGNITO_VARS.filter((name) => !isSet(env, name));
    if (missing.length > 0) {
      problems.push(
        `Cognito is required in a production-like environment; unset: ${missing.join(', ')}.`,
      );
    }
  }

  if (context !== null) {
    for (const boundary of devRequested) {
      const secret = env[boundary.secret];
      if (!secret || secret.trim() === '') {
        problems.push(
          `${boundary.secret} is required when ${boundary.mode}=dev.`,
        );
        continue;
      }
      const weak = weakSecretReason(secret);
      if (weak) problems.push(`${boundary.secret} ${weak}.`);
    }
  }
  // Every pair of dev boundaries in use must have its own secret.
  for (let i = 0; i < devRequested.length; i += 1) {
    for (let j = i + 1; j < devRequested.length; j += 1) {
      const a = env[devRequested[i].secret];
      const b = env[devRequested[j].secret];
      if (a && b && a === b) {
        problems.push(
          `${devRequested[i].secret} and ${devRequested[j].secret} must differ.`,
        );
      }
    }
  }

  // SC1a — the platform pool, when configured: complete and dedicated.
  const platform = COGNITO_POOLS[2];
  const platformPool = (env[platform.pool] ?? '').trim();
  const platformClient = (env[platform.client] ?? '').trim();
  if ((platformPool === '') !== (platformClient === '')) {
    problems.push(
      `${platform.pool} and ${platform.client} must be set together.`,
    );
  }
  for (const other of COGNITO_POOLS.slice(0, 2)) {
    if (
      platformPool !== '' &&
      (env[other.pool] ?? '').trim() === platformPool
    ) {
      problems.push(`${platform.pool} must differ from ${other.pool}.`);
    }
    if (
      platformClient !== '' &&
      (env[other.client] ?? '').trim() === platformClient
    ) {
      problems.push(`${platform.client} must differ from ${other.client}.`);
    }
  }

  return problems;
}

export function assertAuthConfigSafe(env: Env = process.env): void {
  const problems = authConfigProblems(env);
  if (problems.length > 0) throw new AuthConfigurationError(problems);
}
