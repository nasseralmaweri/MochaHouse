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
// failure-counter  count the request on the way in (so a concurrent burst is
//                  limited straight away) and GIVE IT BACK when the handler
//                  reports success — so only requests that did not succeed (a
//                  guest lookup that 404s) accumulate
export type ScopeMode = 'consume' | 'failure-counter';

export interface ScopeDefinition {
  readonly name: string;
  readonly key: readonly KeyPart[];
  readonly limit: number;
  readonly windowSeconds: number;
  readonly appliesTo: ScopeAppliesTo;
  readonly mode: ScopeMode;
}

// Which request-body field carries the identifier a policy keys on. It MUST be
// the field the route's handler acts on: if the limiter read a different field
// than the handler, a caller could put a throwaway value in one and the
// victim's address in the other, and get a fresh bucket for every attempt.
export type IdentifierField = 'identifier' | 'email';

export interface PolicyDefinition {
  readonly name: string;
  // Present only for policies with an identifier scope.
  readonly identifierField: IdentifierField | null;
  // Scopes are evaluated IN ORDER, narrowest first, and evaluation stops at the
  // first refusal: a request refused by a narrow scope never counts against a
  // wider one, so one source cannot use up a shared allowance (a tenant
  // ceiling, a per-identifier ceiling) with requests that were already refused.
  readonly scopes: readonly ScopeDefinition[];
}

export type PolicyName =
  | 'checkout'
  | 'checkout-quote'
  | 'reward-eligibility'
  | 'order-status'
  | 'customer-sign-in'
  | 'internal-sign-in'
  | 'platform-sign-in'
  | 'platform-mfa'
  | 'platform-provisioning'
  | 'platform-lifecycle'
  // SC4e — the onboarding reports (computed per request).
  | 'platform-onboarding-report'
  // SC3b — opening a billing Checkout (a business owner) and receiving
  // billing-provider webhooks.
  | 'billing-checkout'
  | 'billing-webhook'
  | 'account-recovery'
  | 'account-verification'
  // SC4a — business owner self-service registration (no tenant: the tenant
  // part of the key is the fixed "none").
  | 'owner-registration'
  | 'owner-registration-verification'
  // SC4b — a verified owner creating their business.
  | 'owner-onboarding'
  // SC4f-2 — a signed-in customer joining a business.
  | 'customer-enrollment';

interface ScopeDefault {
  name: string;
  key: readonly KeyPart[];
  limit: number;
  windowSeconds: number;
  appliesTo?: ScopeAppliesTo;
  mode?: ScopeMode;
}

interface PolicyDefault {
  identifierField?: IdentifierField;
  scopes: readonly ScopeDefault[];
}

const MINUTE = 60;
const QUARTER_HOUR = 15 * 60;
const FIVE_MINUTES = 5 * 60;
const HOUR = 60 * 60;

// Starting values. The reasoning for each is in the documentation; the short
// version: anonymous per-IP limits are generous because a shop's Wi-Fi puts
// many real customers on one address, the tenant ceiling is the circuit
// breaker against a flood, and credential routes are keyed per identifier AND
// per identifier+IP.
//
// A single source can reach at most (pair limit x windows per hour) against the
// IP-independent per-identifier ceiling, and every ceiling below is set ABOVE
// that, so ONE address can never lock a customer out on its own — doing so
// takes sources on several addresses (rate-limit.config.spec.ts asserts it).
const DEFAULTS: Record<PolicyName, PolicyDefault> = {
  checkout: {
    scopes: [
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
  },
  'checkout-quote': {
    scopes: [
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
  },
  // SC4f-2 — joining a business creates at most one profile per login, so
  // a signed-in customer never needs more than a few attempts; the business
  // ceiling bounds a burst of new logins.
  'customer-enrollment': {
    scopes: [
      {
        name: 'subject',
        key: ['tenant', 'subject'],
        limit: 10,
        windowSeconds: HOUR,
        appliesTo: 'authenticated',
      },
      { name: 'tenant', key: ['tenant'], limit: 600, windowSeconds: HOUR },
    ],
  },
  'reward-eligibility': {
    scopes: [
      {
        name: 'subject',
        key: ['tenant', 'subject'],
        limit: 30,
        windowSeconds: MINUTE,
        appliesTo: 'authenticated',
      },
      { name: 'tenant', key: ['tenant'], limit: 300, windowSeconds: MINUTE },
    ],
  },
  // Customer tracking polls every 15 s per tab (4/min); several tabs and
  // devices for one order stay well inside 30/min. The failure scope counts a
  // lookup on the way in and gives it back on success, so a concurrent burst of
  // guesses is limited at once and a customer's successful polls never keep it.
  'order-status': {
    scopes: [
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
  },
  'customer-sign-in': {
    identifierField: 'identifier',
    scopes: [
      // one source: 10 per 15 min = at most 40/hour, under the ceiling of 60
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
        limit: 60,
        windowSeconds: HOUR,
      },
    ],
  },
  'internal-sign-in': {
    identifierField: 'identifier',
    scopes: [
      // one source: 5 per 15 min = at most 20/hour, under the ceiling of 30
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
        limit: 30,
        windowSeconds: HOUR,
      },
    ],
  },
  // SC1b — CENTERIVO platform-operator sign-in (no tenant: the tenant part of
  // the key is the fixed "none"). Stricter than staff sign-in: a platform
  // operator account is the most privileged credential in the system.
  'platform-sign-in': {
    identifierField: 'email',
    scopes: [
      // one source: 4 per 15 min = at most 16/hour, under the ceiling of 20
      // (so one source can never lock an operator out)
      {
        name: 'identifier-ip',
        key: ['tenant', 'identifier', 'ip'],
        limit: 4,
        windowSeconds: QUARTER_HOUR,
      },
      {
        name: 'ip',
        key: ['tenant', 'ip'],
        limit: 20,
        windowSeconds: FIVE_MINUTES,
      },
      {
        name: 'identifier',
        key: ['tenant', 'identifier'],
        limit: 20,
        windowSeconds: HOUR,
      },
    ],
  },
  // SC1b — the MFA / enrolment steps. This caps how fast one client can call
  // them at all. Code guessing is bounded elsewhere: every code attempt
  // consumes its single-use challenge (a wrong code included), and a new
  // challenge needs the password, which 'platform-sign-in' limits to 20 per
  // hour per operator from any number of addresses. There is deliberately no
  // IP-independent ceiling here: requests with junk handles would spend it
  // and lock every operator out of this step.
  'platform-mfa': {
    scopes: [
      {
        name: 'ip',
        key: ['tenant', 'ip'],
        limit: 20,
        windowSeconds: FIVE_MINUTES,
      },
    ],
  },
  // SC1d — creating a business (after PlatformAuthGuard: an ACTIVE operator
  // with MFA). Far above real use; caps a runaway client or stolen session.
  'platform-provisioning': {
    scopes: [
      {
        name: 'ip',
        key: ['tenant', 'ip'],
        limit: 20,
        windowSeconds: HOUR,
      },
    ],
  },
  // SC1e — suspend / reactivate / owner email correction (after
  // PlatformAuthGuard and the recent-sign-in check).
  'platform-lifecycle': {
    scopes: [
      {
        name: 'ip',
        key: ['tenant', 'ip'],
        limit: 30,
        windowSeconds: HOUR,
      },
    ],
  },
  // SC4e — the Platform Console's onboarding reports (after PlatformAuthGuard
  // and onboarding.view). Each request is computed live; generous for real
  // browsing, it caps a runaway client or stolen session.
  'platform-onboarding-report': {
    scopes: [
      {
        name: 'ip',
        key: ['tenant', 'ip'],
        limit: 300,
        windowSeconds: HOUR,
      },
    ],
  },
  // SC3b — each request can create a provider Checkout session: a small
  // per-business allowance (an open session is reused anyway).
  'billing-checkout': {
    scopes: [
      {
        name: 'ip',
        key: ['tenant', 'ip'],
        limit: 20,
        windowSeconds: HOUR,
      },
      {
        name: 'tenant',
        key: ['tenant'],
        limit: 30,
        windowSeconds: HOUR,
      },
    ],
  },
  // SC3b — signed provider webhooks: generous (the provider retries and
  // bursts), only a ceiling against floods of unsigned requests.
  'billing-webhook': {
    scopes: [
      {
        name: 'ip',
        // No business context on this route: the tenant part is the shared
        // placeholder, as on the platform routes.
        key: ['tenant', 'ip'],
        limit: 600,
        windowSeconds: 10 * 60,
      },
    ],
  },
  // register, resend verification, forgot password: each can send an email or
  // SMS to someone else, so the per-identifier ceiling caps what a victim can
  // be sent per hour no matter how many addresses the attacker uses. These
  // three routes share the policy (register -> resend -> forgot is a normal
  // path), hence 5 per hour per identifier+IP.
  'account-recovery': {
    identifierField: 'email',
    scopes: [
      {
        name: 'identifier-ip',
        key: ['tenant', 'identifier', 'ip'],
        limit: 5,
        windowSeconds: HOUR,
      },
      { name: 'ip', key: ['tenant', 'ip'], limit: 20, windowSeconds: HOUR },
      {
        name: 'identifier',
        key: ['tenant', 'identifier'],
        limit: 10,
        windowSeconds: HOUR,
      },
    ],
  },
  // verify a code, reset a password with a code: guessing a short code is the
  // risk; the codes themselves also expire at the identity provider.
  'account-verification': {
    identifierField: 'email',
    scopes: [
      // one source: 10 per 15 min = at most 40/hour, under the ceiling of 60
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
        limit: 60,
        windowSeconds: HOUR,
      },
    ],
  },
  // SC4a — starting (or resending) an owner registration emails a code to
  // the address given, so it is capped like 'account-recovery': per
  // identifier+IP, per IP, and an IP-independent ceiling per address (what a
  // victim can be sent per hour however many addresses an attacker uses).
  // The service adds its own per-email (5 per 24 h) and global daily quotas.
  'owner-registration': {
    identifierField: 'email',
    scopes: [
      // one source: 3 per hour, under the ceiling of 6
      {
        name: 'identifier-ip',
        key: ['tenant', 'identifier', 'ip'],
        limit: 3,
        windowSeconds: HOUR,
      },
      { name: 'ip', key: ['tenant', 'ip'], limit: 10, windowSeconds: HOUR },
      // A daily cap per address, so one source cannot use up the service's
      // global daily quota of new registrations on its own.
      {
        name: 'ip-daily',
        key: ['tenant', 'ip'],
        limit: 20,
        windowSeconds: 24 * HOUR,
      },
      {
        name: 'identifier',
        key: ['tenant', 'identifier'],
        limit: 6,
        windowSeconds: HOUR,
      },
    ],
  },
  // SC4a — completing a registration with a code. Code guessing is also
  // bounded by the service (5 attempts per code); this caps how fast.
  'owner-registration-verification': {
    identifierField: 'email',
    scopes: [
      // one source: 5 per 15 min = at most 20/hour, under the ceiling of 30
      {
        name: 'identifier-ip',
        key: ['tenant', 'identifier', 'ip'],
        limit: 5,
        windowSeconds: QUARTER_HOUR,
      },
      {
        name: 'ip',
        key: ['tenant', 'ip'],
        limit: 20,
        windowSeconds: QUARTER_HOUR,
      },
      {
        name: 'identifier',
        key: ['tenant', 'identifier'],
        limit: 30,
        windowSeconds: HOUR,
      },
    ],
  },
  // SC4b — creating a business (after InternalIdentityGuard: a verified
  // owner, at most one business each). Far above real use; caps a runaway
  // client.
  'owner-onboarding': {
    scopes: [
      { name: 'ip', key: ['tenant', 'ip'], limit: 20, windowSeconds: HOUR },
    ],
  },
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
  for (const [policyName, policy] of Object.entries(DEFAULTS) as [
    PolicyName,
    PolicyDefault,
  ][]) {
    policies[policyName] = {
      name: policyName,
      identifierField: policy.identifierField ?? null,
      scopes: policy.scopes.map((scope) => {
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

export function isProductionLike(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const signals = [
    env.NODE_ENV,
    env.CENTERIVO_ENV,
    env.APP_ENV,
    env.DEPLOYMENT_ENV,
    env.ENVIRONMENT,
  ].map((value) => (value ?? '').trim().toLowerCase());
  return ['production', 'prod', 'staging', 'live'].some((value) =>
    signals.includes(value),
  );
}

// Startup floor, in the style of the dev-auth guard: protection is never
// switched off in a production-like environment by accident.
export function assertRateLimitConfigSafe(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitConfig {
  const config = loadRateLimitConfig(env);
  if (isProductionLike(env) && !config.enabled) {
    throw new RateLimitConfigurationError(
      'RATE_LIMIT_ENABLED=0 is not allowed in a production-like environment.',
    );
  }
  return config;
}
