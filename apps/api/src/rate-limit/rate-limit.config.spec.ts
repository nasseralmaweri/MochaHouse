import {
  RateLimitConfigurationError,
  assertRateLimitConfigSafe,
  loadRateLimitConfig,
  scopeVariables,
  type PolicyName,
} from './rate-limit.config';

const SECRET = 'a-shared-secret-that-is-at-least-32-chars-long';

describe('loadRateLimitConfig', () => {
  it('defines every policy with positive limits and windows', () => {
    const config = loadRateLimitConfig({});
    const names: PolicyName[] = [
      'checkout',
      'checkout-quote',
      'reward-eligibility',
      'order-status',
      'customer-sign-in',
      'internal-sign-in',
      'platform-sign-in',
      'platform-mfa',
      'platform-provisioning',
      'account-recovery',
      'account-verification',
    ];
    for (const name of names) {
      const policy = config.policies[name];
      expect(policy.scopes.length).toBeGreaterThan(0);
      for (const scope of policy.scopes) {
        expect(scope.limit).toBeGreaterThan(0);
        expect(scope.windowSeconds).toBeGreaterThan(0);
      }
    }
    expect(config.enabled).toBe(true);
  });

  it('keeps the safe defaults the design relies on', () => {
    const { policies } = loadRateLimitConfig({});
    const scope = (policy: PolicyName, name: string) =>
      policies[policy].scopes.find((s) => s.name === name)!;
    // Normal customer polling (4/min per tab) stays far under the order limit.
    expect(scope('order-status', 'order').limit).toBeGreaterThanOrEqual(20);
    // Failed lookups are counted separately from successful polls.
    expect(scope('order-status', 'failures').mode).toBe('failure-counter');
    // Credential routes always have a pair scope AND an IP-independent ceiling.
    for (const policy of [
      'customer-sign-in',
      'internal-sign-in',
      'platform-sign-in',
      'account-recovery',
      'account-verification',
    ] as const) {
      expect(scope(policy, 'identifier-ip').key).toEqual([
        'tenant',
        'identifier',
        'ip',
      ]);
      expect(scope(policy, 'identifier').key).toEqual(['tenant', 'identifier']);
    }
    // Internal sign-in is stricter than customer sign-in.
    expect(scope('internal-sign-in', 'identifier-ip').limit).toBeLessThan(
      scope('customer-sign-in', 'identifier-ip').limit,
    );
    // Authenticated checkout is not limited by IP (shared shop networks).
    expect(scope('checkout', 'subject').appliesTo).toBe('authenticated');
    expect(scope('checkout', 'ip').appliesTo).toBe('anonymous');
    // Every policy that takes a tenant key includes it (tenant isolation).
    for (const policy of Object.values(policies)) {
      for (const s of policy.scopes) expect(s.key).toContain('tenant');
    }
  });

  it('lets each scope be tuned from the environment', () => {
    const variables = scopeVariables('checkout', 'ip');
    expect(variables).toEqual({
      limit: 'RATE_LIMIT_CHECKOUT_IP_LIMIT',
      windowSeconds: 'RATE_LIMIT_CHECKOUT_IP_WINDOW_SECONDS',
    });
    expect(scopeVariables('customer-sign-in', 'identifier-ip').limit).toBe(
      'RATE_LIMIT_CUSTOMER_SIGN_IN_IDENTIFIER_IP_LIMIT',
    );
    const tuned = loadRateLimitConfig({
      RATE_LIMIT_CHECKOUT_IP_LIMIT: '7',
      RATE_LIMIT_CHECKOUT_IP_WINDOW_SECONDS: '90',
    });
    const ip = tuned.policies.checkout.scopes.find((s) => s.name === 'ip')!;
    expect([ip.limit, ip.windowSeconds]).toEqual([7, 90]);
  });

  it.each(['0', '-3', '1.5', 'abc', '9999999'])(
    'rejects a malformed limit (%s) instead of falling back quietly',
    (value) => {
      expect(() =>
        loadRateLimitConfig({ RATE_LIMIT_CHECKOUT_IP_LIMIT: value }),
      ).toThrow(RateLimitConfigurationError);
    },
  );

  it('treats a blank value as unset', () => {
    const config = loadRateLimitConfig({ RATE_LIMIT_CHECKOUT_IP_LIMIT: '  ' });
    expect(
      config.policies.checkout.scopes.find((s) => s.name === 'ip')!.limit,
    ).toBe(30);
  });

  describe('client IP mode', () => {
    it("is 'off' when nothing is declared (no per-IP limits on an undeclared topology)", () => {
      expect(loadRateLimitConfig({}).clientIpMode).toBe('off');
    });

    it("is 'forwarded' when a secret is configured, unless overridden", () => {
      expect(
        loadRateLimitConfig({ CLIENT_IP_FORWARD_SECRET: SECRET }).clientIpMode,
      ).toBe('forwarded');
      expect(
        loadRateLimitConfig({
          CLIENT_IP_FORWARD_SECRET: SECRET,
          RATE_LIMIT_CLIENT_IP_MODE: 'peer',
        }).clientIpMode,
      ).toBe('peer');
    });

    it("explicit 'peer' and 'off' are honoured", () => {
      expect(
        loadRateLimitConfig({ RATE_LIMIT_CLIENT_IP_MODE: 'peer' }).clientIpMode,
      ).toBe('peer');
      expect(
        loadRateLimitConfig({ RATE_LIMIT_CLIENT_IP_MODE: 'OFF' }).clientIpMode,
      ).toBe('off');
    });

    it("refuses 'forwarded' without a secret, a short secret, and unknown modes", () => {
      expect(() =>
        loadRateLimitConfig({ RATE_LIMIT_CLIENT_IP_MODE: 'forwarded' }),
      ).toThrow(RateLimitConfigurationError);
      expect(() =>
        loadRateLimitConfig({ CLIENT_IP_FORWARD_SECRET: 'too-short' }),
      ).toThrow(RateLimitConfigurationError);
      expect(() =>
        loadRateLimitConfig({ RATE_LIMIT_CLIENT_IP_MODE: 'magic' }),
      ).toThrow(RateLimitConfigurationError);
    });
  });

  it('validates the enabled switch and the Redis timeout', () => {
    expect(loadRateLimitConfig({ RATE_LIMIT_ENABLED: '0' }).enabled).toBe(
      false,
    );
    expect(() => loadRateLimitConfig({ RATE_LIMIT_ENABLED: 'maybe' })).toThrow(
      RateLimitConfigurationError,
    );
    expect(() =>
      loadRateLimitConfig({ RATE_LIMIT_REDIS_TIMEOUT_MS: '-1' }),
    ).toThrow(RateLimitConfigurationError);
    expect(loadRateLimitConfig({}).redisTimeoutMs).toBe(300);
  });
});

describe('policy invariants', () => {
  const { policies } = loadRateLimitConfig({});

  it('lists scopes narrowest first, so a refused request never counts against a wider one', () => {
    for (const policy of Object.values(policies)) {
      const widths = policy.scopes.map((scope) => scope.key.length);
      expect([...widths].sort((a, b) => b - a)).toEqual(widths);
    }
  });

  it('names the identifier field each credential policy keys on (the one its handler reads)', () => {
    expect(policies['customer-sign-in'].identifierField).toBe('identifier');
    expect(policies['internal-sign-in'].identifierField).toBe('identifier');
    // SC1b — the platform sign-in handler reads `email`.
    expect(policies['platform-sign-in'].identifierField).toBe('email');
    expect(policies['platform-mfa'].identifierField).toBeNull();
    expect(policies['account-recovery'].identifierField).toBe('email');
    expect(policies['account-verification'].identifierField).toBe('email');
    for (const name of [
      'checkout',
      'checkout-quote',
      'reward-eligibility',
      'order-status',
    ] as const) {
      expect(policies[name].identifierField).toBeNull();
    }
  });

  it('SC1b: every platform-mfa scope includes the client address (junk requests cannot lock every operator out)', () => {
    const scopes = policies['platform-mfa'].scopes;
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) expect(scope.key).toContain('ip');
  });

  it('keeps every per-identifier ceiling above what ONE address can reach, so one source cannot lock a customer out', () => {
    for (const name of [
      'customer-sign-in',
      'internal-sign-in',
      'platform-sign-in',
      'account-recovery',
      'account-verification',
    ] as const) {
      const pair = policies[name].scopes.find(
        (s) => s.name === 'identifier-ip',
      )!;
      const ceiling = policies[name].scopes.find(
        (s) => s.name === 'identifier',
      )!;
      const hourly = pair.limit * Math.ceil(3600 / pair.windowSeconds);
      // single-source reach in the ceiling's own window must stay under it
      const reachInCeilingWindow =
        pair.limit * Math.ceil(ceiling.windowSeconds / pair.windowSeconds);
      expect(reachInCeilingWindow).toBeLessThan(ceiling.limit);
      expect(hourly).toBeLessThan(ceiling.limit + 1);
    }
  });
});

describe('assertRateLimitConfigSafe', () => {
  it('allows disabling rate limiting only outside production-like environments', () => {
    expect(() =>
      assertRateLimitConfigSafe({
        NODE_ENV: 'development',
        RATE_LIMIT_ENABLED: '0',
      }),
    ).not.toThrow();
    for (const signal of [
      { NODE_ENV: 'production' },
      { NODE_ENV: 'development', APP_ENV: 'staging' },
      { CENTERIVO_ENV: 'live' },
      { DEPLOYMENT_ENV: 'prod' },
    ]) {
      expect(() =>
        assertRateLimitConfigSafe({ ...signal, RATE_LIMIT_ENABLED: '0' }),
      ).toThrow(RateLimitConfigurationError);
    }
  });

  it('accepts a normal production configuration', () => {
    expect(() =>
      assertRateLimitConfigSafe({
        NODE_ENV: 'production',
        CLIENT_IP_FORWARD_SECRET: SECRET,
      }),
    ).not.toThrow();
    expect(() =>
      assertRateLimitConfigSafe({ NODE_ENV: 'production' }),
    ).not.toThrow();
  });

  it('still rejects malformed values in production', () => {
    expect(() =>
      assertRateLimitConfigSafe({
        NODE_ENV: 'production',
        RATE_LIMIT_CHECKOUT_IP_LIMIT: 'x',
      }),
    ).toThrow(RateLimitConfigurationError);
  });
});
