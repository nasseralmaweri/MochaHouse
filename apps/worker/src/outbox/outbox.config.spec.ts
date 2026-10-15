import { loadOutboxConfig } from './outbox.config';

const env = (values: Record<string, string>) =>
  values as unknown as NodeJS.ProcessEnv;
// Most cases are not about NODE_ENV: run them as a test environment.
const dev = (values: Record<string, string>) =>
  env({ NODE_ENV: 'test', ...values });

describe('loadOutboxConfig', () => {
  it('has safe defaults', () => {
    const c = loadOutboxConfig(env({ NODE_ENV: 'test' }), 'host', 42);
    expect(c).toMatchObject({
      enabled: true,
      concurrency: 2,
      pollIntervalMs: 2000,
      leaseSeconds: 60,
      sendTimeoutMs: 10_000,
      maxAttempts: 7,
      backoffBaseMs: 30_000,
      historicalCutoff: null,
      workerId: 'host:42',
    });
    // A send is only begun with at least send timeout + 5 s of lease left.
    expect(c.minLeaseRemainingMs).toBe(15_000);
  });

  it('can be switched off for a cut-over', () => {
    for (const off of ['0', 'false', 'FALSE', ' 0 ']) {
      expect(
        loadOutboxConfig(dev({ OUTBOX_WORKER_ENABLED: off })).enabled,
      ).toBe(false);
    }
    for (const on of ['1', 'true', 'True']) {
      expect(loadOutboxConfig(dev({ OUTBOX_WORKER_ENABLED: on })).enabled).toBe(
        true,
      );
    }
  });

  it('the kill switch is strict: a typo must not start a worker', () => {
    for (const bad of ['off', 'no', 'disabled', '00', 'flase', 'yes']) {
      expect(() =>
        loadOutboxConfig(dev({ OUTBOX_WORKER_ENABLED: bad })),
      ).toThrow(/OUTBOX_WORKER_ENABLED must be/);
    }
  });

  it.each([
    ['OUTBOX_CONCURRENCY', '0'],
    ['OUTBOX_CONCURRENCY', '11'],
    ['OUTBOX_CONCURRENCY', 'two'],
    ['OUTBOX_MAX_ATTEMPTS', '-1'],
    ['OUTBOX_LEASE_SECONDS', '5'],
    ['OUTBOX_SEND_TIMEOUT_MS', '100'],
    ['OUTBOX_POLL_INTERVAL_MS', '1.5'],
  ])('refuses a malformed %s=%s instead of falling back', (name, value) => {
    expect(() => loadOutboxConfig(dev({ [name]: value }))).toThrow(name);
  });

  it('refuses a lease too short to hold a send', () => {
    expect(() =>
      loadOutboxConfig(
        dev({ OUTBOX_LEASE_SECONDS: '20', OUTBOX_SEND_TIMEOUT_MS: '30000' }),
      ),
    ).toThrow(/lease/i);
  });

  it('refuses a backoff cap below the base', () => {
    expect(() =>
      loadOutboxConfig(
        dev({ OUTBOX_BACKOFF_BASE_MS: '60000', OUTBOX_BACKOFF_CAP_MS: '1000' }),
      ),
    ).toThrow(/CAP/);
  });

  describe('historical cut-off (cut-over safety)', () => {
    it('parses an ISO-8601 instant', () => {
      const c = loadOutboxConfig(
        dev({ OUTBOX_HISTORICAL_CUTOFF: '2026-10-01T14:00:00Z' }),
      );
      expect(c.historicalCutoff?.toISOString()).toBe(
        '2026-10-01T14:00:00.000Z',
      );
    });
    it('requires an explicit time zone so it never depends on the host clock zone', () => {
      expect(() =>
        loadOutboxConfig(
          dev({ OUTBOX_HISTORICAL_CUTOFF: '2026-10-01T14:00:00' }),
        ),
      ).toThrow(/time zone/);
      const offset = loadOutboxConfig(
        dev({ OUTBOX_HISTORICAL_CUTOFF: '2026-10-01T10:00:00-04:00' }),
      );
      expect(offset.historicalCutoff?.toISOString()).toBe(
        '2026-10-01T14:00:00.000Z',
      );
    });
    it('refuses a cut-off in the future, which would silently hold back every new event', () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      expect(() =>
        loadOutboxConfig(dev({ OUTBOX_HISTORICAL_CUTOFF: future })),
      ).toThrow(/future/);
      const soon = new Date(Date.now() + 60_000).toISOString(); // small clock skew is tolerated
      expect(() =>
        loadOutboxConfig(dev({ OUTBOX_HISTORICAL_CUTOFF: soon })),
      ).not.toThrow();
    });
    it('rejects anything that is not an ISO timestamp', () => {
      for (const bad of ['yesterday', '2026-10-20', '1700000000', 'NaN']) {
        expect(() =>
          loadOutboxConfig(dev({ OUTBOX_HISTORICAL_CUTOFF: bad })),
        ).toThrow(/ISO-8601/);
      }
    });
    it('is REQUIRED unless the environment is clearly development or test (unset or misspelt NODE_ENV included)', () => {
      for (const mode of [
        'production',
        'staging',
        'prod',
        'Production',
        'qa',
        '',
      ]) {
        expect(() => loadOutboxConfig(env({ NODE_ENV: mode }))).toThrow(
          /OUTBOX_HISTORICAL_CUTOFF is required/,
        );
      }
    });
    it('"none" is an explicit, deliberate answer once the backlog is classified', () => {
      const c = loadOutboxConfig(
        env({ NODE_ENV: 'production', OUTBOX_HISTORICAL_CUTOFF: 'none' }),
      );
      expect(c.historicalCutoff).toBeNull();
    });
    it('a disabled worker does not need it', () => {
      expect(() =>
        loadOutboxConfig(
          env({ NODE_ENV: 'production', OUTBOX_WORKER_ENABLED: '0' }),
        ),
      ).not.toThrow();
    });
    it('an unset NODE_ENV is treated as production-like', () => {
      expect(() => loadOutboxConfig(env({}))).toThrow(
        /OUTBOX_HISTORICAL_CUTOFF is required/,
      );
    });
    it('development and test need no cut-off', () => {
      expect(() =>
        loadOutboxConfig(env({ NODE_ENV: 'development' })),
      ).not.toThrow();
      expect(() => loadOutboxConfig(env({ NODE_ENV: 'test' }))).not.toThrow();
    });
  });
});
