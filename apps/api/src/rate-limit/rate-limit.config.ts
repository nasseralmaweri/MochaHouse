// R1 / S3a — the rate-limit policies for the PUBLIC API, as data.
//
// Every limit here is a STARTING value, overridable per scope from the
// environment (see docs/security/public-api-rate-limiting.md), so a pilot can
// be tuned from measurements instead of guesses. Nothing is specific to any
// business: the tenant is part of every key, taken from the request's
// server-resolved TenantContext, never from client input.
//
// How a request is identified (see client-identity.ts for the client IP):
//   subject     a verified signed-in customer (provider + subject)
//   ip          the client IP — only when a trustworthy source is configured
//   identifier  the sign-in / recovery identifier (an email), HASHED
//   order       the order id of a guest status lookup
//   tenant      the business the request belongs to
//
// A scope whose key needs something the request does not have is skipped (an
// anonymous request has no subject; an unconfigured deployment has no trusted
// IP), so the remaining scopes still protect the route.

export type KeyPart = 'tenant' | 'ip' | 'subject' | 'identifier' | 'order';

export type ScopeAppliesTo = 'any' | 'anonymous' | 'authenticated';

// consume          count this request in the scope (the normal case)
// failure-counter  only CHECK the scope on the way in; the handler records a
//                  failure into it (for example a guest lookup that 404s), so
//                  successful requests never count against it
export type ScopeMode = 'consume' | 'failure-counter';

export interface ScopeDefinition {
  readonly name: string;
  readonly key: readonly KeyPart[];
  readonly limit: number;
  readonly windowSeconds: number;
  readonly appliesTo: ScopeAppliesTo;
  readonly mode: ScopeMode;
}

export interface PolicyDefinition {
  readonly name: string;
  readonly scopes: readonly ScopeDefinition[];
}

export type PolicyName =
  | 'checkout'
  | 'checkout-quote'
  | 'reward-eligibility'
  | 'order-status'
  | 'customer-sign-in'
  | 'internal-sign-in'
  | 'account-recovery'
  | 'account-verification';

interface ScopeDefault {
  name: string;
  key: readonly KeyPart[];
  limit: number;
  windowSeconds: number;
  appliesTo?: ScopeAppliesTo;
  mode?: ScopeMode;
}

const MINUTE = 60;
const QUARTER_HOUR = 15 * 60;
const FIVE_MINUTES = 5 * 60;
const HOUR = 60 * 60;

// Starting values. The reasoning for each is in the documentation; the short
// version: anonymous per-IP limits are generous because a shop's Wi-Fi puts
// many real customers on one address, the tenant ceiling is the circuit
// breaker against a flood, and credential routes are keyed per identifier AND
// per identifier+IP so one attacker cannot lock a customer out from elsewhere
// by burning only the IP-independent allowance.
const DEFAULTS: Record<PolicyName, readonly ScopeDefault[]> = {
  checkout: [
    {
      name: 'subject',
      key: ['tenant', 'subject'],
      limit: 30,
      windowSeconds: MINUTE,
      appliesTo: 'authenticated',
    },
    {
      name: 'ip',
      key: ['tenant', 'ip'],
      limit: 30,
      windowSeconds: MINUTE,
      appliesTo: 'anonymous',
    },
    { name: 'tenant', key: ['tenant'], limit: 300, windowSeconds: MINUTE },
  ],
  'checkout-quote': [
    {
      name: 'subject',
      key: ['tenant', 'subject'],
      limit: 60,
      windowSeconds: MINUTE,
      appliesTo: 'authenticated',
    },
    {
      name: 'ip',
      key: ['tenant', 'ip'],
      limit: 60,
      windowSeconds: MINUTE,
      appliesTo: 'anonymous',
    },
    { name: 'tenant', key: ['tenant'], limit: 600, windowSeconds: MINUTE },
  ],
  'reward-eligibility': [
    {
      name: 'subject',
      key: ['tenant', 'subject'],
      limit: 30,
      windowSeconds: MINUTE,
      appliesTo: 'authenticated',
    },
    { name: 'tenant', key: ['tenant'], limit: 300, windowSeconds: MINUTE },
  ],
  // Customer tracking polls every 15 s per tab (4/min); several tabs and
  // devices for one order stay well inside 30/min.
  'order-status': [
    {
      name: 'order',
      key: ['tenant', 'order'],
      limit: 30,
      windowSeconds: MINUTE,
    },
    {
      name: 'failures',
      key: ['tenant', 'ip'],
      limit: 20,
      windowSeconds: FIVE_MINUTES,
      mode: 'failure-counter',
    },
    { name: 'tenant', key: ['tenant'], limit: 1200, windowSeconds: MINUTE },
  ],
  'customer-sign-in': [
    {
      name: 'identifier-ip',
      key: ['tenant', 'identifier', 'ip'],
      limit: 10,
      windowSeconds: QUARTER_HOUR,
    },
    {
      name: 'ip',
      key: ['tenant', 'ip'],
      limit: 60,
      windowSeconds: FIVE_MINUTES,
    },
    {
      name: 'identifier',
      key: ['tenant', 'identifier'],
      limit: 40,
      windowSeconds: HOUR,
    },
  ],
  'internal-sign-in': [
    {
      name: 'identifier-ip',
      key: ['tenant', 'identifier', 'ip'],
      limit: 5,
      windowSeconds: QUARTER_HOUR,
    },
    {
      name: 'ip',
      key: ['tenant', 'ip'],
      limit: 30,
      windowSeconds: FIVE_MINUTES,
    },
    {
      name: 'identifier',
      key: ['tenant', 'identifier'],
      limit: 20,
      windowSeconds: HOUR,
    },
  ],
  // register, resend verification, forgot password: each can send an email or
  // SMS to someone else, so the per-identifier ceiling caps what a victim can
  // be sent per hour no matter how many addresses the attacker uses.
  'account-recovery': [
    {
      name: 'identifier-ip',
      key: ['tenant', 'identifier', 'ip'],
      limit: 3,
      windowSeconds: HOUR,
    },
    { name: 'ip', key: ['tenant', 'ip'], limit: 10, windowSeconds: HOUR },
    {
      name: 'identifier',
      key: ['tenant', 'identifier'],
      limit: 6,
      windowSeconds: HOUR,
    },
  ],
  // verify a code, reset a password with a code: guessing a short code is the
  // risk, so these are tighter per identifier than the email-sending routes
  // are per window, but the codes themselves expire at the identity provider.
  'account-verification': [
    {
      name: 'identifier-ip',
      key: ['tenant', 'identifier', 'ip'],
      limit: 10,
      windowSeconds: QUARTER_HOUR,
    },
    {
      name: 'ip',
      key: ['tenant', 'ip'],
      limit: 30,
      windowSeconds: QUARTER_HOUR,
    },
    {
      name: 'identifier',
      key: ['tenant', 'identifier'],
      limit: 30,
      windowSeconds: HOUR,
    },
  ],
};

export class RateLimitConfigurationError extends Error {}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  variable: string,
  fallback: number,
): number {
  const raw = env[variable];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 1_000_000) {
    throw new RateLimitConfigurationError(
      `${variable} must be a positive whole number (got "${raw}").`,
    );
  }
  return value;
}

const envSegment = (text: string): string =>
  text.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

// The environment variables that tune one scope, for example
// RATE_LIMIT_CHECKOUT_IP_LIMIT and RATE_LIMIT_CHECKOUT_IP_WINDOW_SECONDS.
export function scopeVariables(
  policy: string,
  scope: string,
): { limit: string; windowSeconds: string } {
  const base = `RATE_LIMIT_${envSegment(policy)}_${envSegment(scope)}`;
  return { limit: `${base}_LIMIT`, windowSeconds: `${base}_WINDOW_SECONDS` };
}

export type ClientIpMode = 'forwarded' | 'peer' | 'off';

export interface RateLimitConfig {
  readonly enabled: boolean;
  readonly redisTimeoutMs: number;
  readonly clientIpMode: ClientIpMode;
  readonly forwardSecret: string | null;
  readonly policies: Readonly<Record<PolicyName, PolicyDefinition>>;
}

export const MIN_FORWARD_SECRET_LENGTH = 32;

// Builds the effective configuration from the environment, failing loudly on
// any malformed value rather than quietly falling back to something looser.
export function loadRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitConfig {
  const enabledRaw = (env.RATE_LIMIT_ENABLED ?? '1').trim().toLowerCase();
  if (!['1', '0', 'true', 'false'].includes(enabledRaw)) {
    throw new RateLimitConfigurationError('RATE_LIMIT_ENABLED must be 1 or 0.');
  }
  const enabled = enabledRaw === '1' || enabledRaw === 'true';

  const forwardSecretRaw = env.CLIENT_IP_FORWARD_SECRET?.trim() ?? '';
  const forwardSecret = forwardSecretRaw === '' ? null : forwardSecretRaw;
  if (
    forwardSecret !== null &&
    forwardSecret.length < MIN_FORWARD_SECRET_LENGTH
  ) {
    throw new RateLimitConfigurationError(
      `CLIENT_IP_FORWARD_SECRET must be at least ${MIN_FORWARD_SECRET_LENGTH} characters.`,
    );
  }

  // How a request's client IP is trusted:
  //   forwarded  a web/proxy tier sends a signed client IP (requires the
  //              secret); requests without it use the connection's peer IP
  //   peer       the connection's peer IP (as resolved by Express "trust
  //              proxy") IS the client — only correct when callers reach this
  //              API directly or through proxies counted in
  //              TRUSTED_PROXY_HOP_COUNT
  //   off        no per-IP limits (the safe default when the topology is not
  //              declared): tenant, subject, identifier and order scopes
  //              still apply
  const modeRaw = (env.RATE_LIMIT_CLIENT_IP_MODE ?? '').trim().toLowerCase();
  let clientIpMode: ClientIpMode;
  if (modeRaw === '') {
    clientIpMode = forwardSecret !== null ? 'forwarded' : 'off';
  } else if (
    modeRaw === 'forwarded' ||
    modeRaw === 'peer' ||
    modeRaw === 'off'
  ) {
    clientIpMode = modeRaw;
  } else {
    throw new RateLimitConfigurationError(
      'RATE_LIMIT_CLIENT_IP_MODE must be forwarded, peer or off.',
    );
  }
  if (clientIpMode === 'forwarded' && forwardSecret === null) {
    throw new RateLimitConfigurationError(
      'RATE_LIMIT_CLIENT_IP_MODE=forwarded needs CLIENT_IP_FORWARD_SECRET.',
    );
  }

  const policies = {} as Record<PolicyName, PolicyDefinition>;
  for (const [policyName, scopes] of Object.entries(DEFAULTS) as [
    PolicyName,
    readonly ScopeDefault[],
  ][]) {
    policies[policyName] = {
      name: policyName,
      scopes: scopes.map((scope) => {
        const variables = scopeVariables(policyName, scope.name);
        return {
          name: scope.name,
          key: scope.key,
          limit: positiveInteger(env, variables.limit, scope.limit),
          windowSeconds: positiveInteger(
            env,
            variables.windowSeconds,
            scope.windowSeconds,
          ),
          appliesTo: scope.appliesTo ?? 'any',
          mode: scope.mode ?? 'consume',
        };
      }),
    };
  }

  return {
    enabled,
    redisTimeoutMs: positiveInteger(env, 'RATE_LIMIT_REDIS_TIMEOUT_MS', 300),
    clientIpMode,
    forwardSecret,
    policies,
  };
}

// Startup floor, in the style of the dev-auth guard: protection is never
// switched off in a production-like environment by accident.
export function assertRateLimitConfigSafe(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitConfig {
  const config = loadRateLimitConfig(env);
  const production = ['production', 'prod', 'staging', 'live'].some((value) =>
    [
      env.NODE_ENV,
      env.CENTERIVO_ENV,
      env.APP_ENV,
      env.DEPLOYMENT_ENV,
      env.ENVIRONMENT,
    ]
      .map((v) => (v ?? '').trim().toLowerCase())
      .includes(value),
  );
  if (production && !config.enabled) {
    throw new RateLimitConfigurationError(
      'RATE_LIMIT_ENABLED=0 is not allowed in a production-like environment.',
    );
  }
  return config;
}
