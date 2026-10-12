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
//   - A mode variable (AUTH_PROVIDER, INTERNAL_AUTH_PROVIDER) that is not
//     exactly "cognito", "dev" or unset. A typo such as "Dev" would otherwise
//     silently select Cognito.
//   - Development auth requested outside a verified safe context (see
//     dev-auth-context.ts): any production-like signal, an unset or unknown
//     NODE_ENV, a missing ALLOW_DEV_AUTH=1 opt-in, or a non-loopback database.
//   - ALLOW_DEV_AUTH set to anything but 1 or unset, or set at all in a
//     production-like environment.
//   - In a production-like environment: any dev JWT secret still present (even
//     with Cognito selected — it means a copied dev configuration and the mode
//     could flip), PAYMENT_PROVIDER=fake, and missing Cognito pool / client ids
//     (otherwise auth only fails at the first request).
//   - Dev requested in local mode with a missing, short, repeated-character or
//     placeholder secret — including the public CI values — and, in any
//     context, the same secret used for both the customer and internal boundary.
//     Isolated test runs keep using the CI placeholder secrets.

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
] as const;

const COGNITO_VARS = [
  'COGNITO_USER_POOL_ID',
  'COGNITO_CLIENT_ID',
  'INTERNAL_COGNITO_USER_POOL_ID',
  'INTERNAL_COGNITO_CLIENT_ID',
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
    if ((env.PAYMENT_PROVIDER ?? '').trim().toLowerCase() === 'fake') {
      problems.push(
        `PAYMENT_PROVIDER=fake is not allowed in a production-like environment (${signal}).`,
      );
    }
    const missing = COGNITO_VARS.filter((name) => !isSet(env, name));
    if (missing.length > 0) {
      problems.push(
        `Cognito is required in a production-like environment; unset: ${missing.join(', ')}.`,
      );
    }
  }

  if (context === 'local') {
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
  if (devRequested.length === BOUNDARIES.length) {
    const [customer, internal] = BOUNDARIES.map((b) => env[b.secret]);
    if (customer && internal && customer === internal) {
      problems.push(
        `${BOUNDARIES[0].secret} and ${BOUNDARIES[1].secret} must differ.`,
      );
    }
  }

  return problems;
}

export function assertAuthConfigSafe(env: Env = process.env): void {
  const problems = authConfigProblems(env);
  if (problems.length > 0) throw new AuthConfigurationError(problems);
}
