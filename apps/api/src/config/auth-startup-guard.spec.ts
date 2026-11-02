import { assertTestEnvironment } from '@mocha-house/testing';
import * as database from '@mocha-house/database';
import * as seedGuard from '@mocha-house/database/dist/testing/seed-guard';
import {
  AuthConfigurationError,
  assertAuthConfigSafe,
  authConfigProblems,
} from './auth-startup-guard';
import { devAuthContext, isSafeDevAuthContext } from './dev-auth-context';
import { isDevCustomerAuthEnabled } from '../customer-auth/infrastructure/auth-provider-mode';
import { isDevInternalAuthEnabled } from '../internal-auth/infrastructure/internal-auth-provider-mode';
import {
  PaymentConfigurationError,
  resolvePaymentProviderMode,
} from '../payment/payment-provider-mode';

// ESP-02 — fail-closed startup validation of dev authentication, dev secrets
// and the simulated payment provider. Pure decisions over environment objects:
// no database, no Nest, no network. The same classifier backs the request-time
// gates, which the last sections check against the startup decision.

type Env = Record<string, string | undefined>;

const CUSTOMER_SECRET = 'customer-dev-secret-for-local-use-0001';
const INTERNAL_SECRET = 'internal-dev-secret-for-local-use-0002';

// A developer machine: opt-in, development, loopback database, strong secrets.
const LOCAL: Env = {
  NODE_ENV: 'development',
  ALLOW_DEV_AUTH: '1',
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/mocha_dev',
  AUTH_PROVIDER: 'dev',
  INTERNAL_AUTH_PROVIDER: 'dev',
  AUTH_DEV_JWT_SECRET: CUSTOMER_SECRET,
  INTERNAL_AUTH_DEV_JWT_SECRET: INTERNAL_SECRET,
};

// CI / a Jest run: the values .github/workflows/ci.yml sets (public in the
// repository), declared test run, no ALLOW_DEV_AUTH.
const CI: Env = {
  NODE_ENV: 'test',
  CENTERIVO_TEST_DATABASE: '1',
  CENTERIVO_TEST_DB_TOKEN: 'ci-run-1234567-1',
  AUTH_PROVIDER: 'dev',
  INTERNAL_AUTH_PROVIDER: 'dev',
  AUTH_DEV_JWT_SECRET: 'ci-customer-dev-secret-not-a-real-credential',
  INTERNAL_AUTH_DEV_JWT_SECRET: 'ci-internal-dev-secret-not-a-real-credential',
  DATABASE_URL: 'postgresql://mocha:mocha@localhost:5432/mocha_ci',
  PAYMENT_PROVIDER: 'fake',
};

// A declared test run that boots a real API server (not how CI runs): the same
// test declaration, but with credentials that meet the server requirements.
const TEST_SERVER: Env = {
  ...CI,
  AUTH_DEV_JWT_SECRET: CUSTOMER_SECRET,
  INTERNAL_AUTH_DEV_JWT_SECRET: INTERNAL_SECRET,
};

// A real deployment: Cognito, no dev anything.
const COGNITO: Env = {
  COGNITO_USER_POOL_ID: 'us-east-1_abc123',
  COGNITO_CLIENT_ID: 'clientid',
  INTERNAL_COGNITO_USER_POOL_ID: 'us-east-1_def456',
  INTERNAL_COGNITO_CLIENT_ID: 'internalclientid',
};
const PRODUCTION: Env = { NODE_ENV: 'production', ...COGNITO };

const problems = (env: Env) => authConfigProblems(env);
const refuses = (env: Env) => problems(env).length > 0;

describe('dev auth startup validation (ESP-02)', () => {
  describe('production, staging and live are refused', () => {
    it.each([
      'production',
      'prod',
      'staging',
      'live',
      'Production',
      ' production ',
    ])(
      'NODE_ENV=%j with development auth is refused, even with every other opt-in',
      (nodeEnv) => {
        expect(refuses({ ...LOCAL, NODE_ENV: nodeEnv })).toBe(true);
        expect(refuses({ ...CI, NODE_ENV: nodeEnv })).toBe(true);
        expect(isSafeDevAuthContext({ ...LOCAL, NODE_ENV: nodeEnv })).toBe(
          false,
        );
      },
    );

    it('a production-like environment with Cognito and nothing else passes', () => {
      expect(problems(PRODUCTION)).toEqual([]);
      expect(() => assertAuthConfigSafe(PRODUCTION)).not.toThrow();
      for (const nodeEnv of ['staging', 'prod', 'live']) {
        expect(problems({ ...PRODUCTION, NODE_ENV: nodeEnv })).toEqual([]);
      }
    });
  });

  describe('conflicting and ambiguous environments are refused', () => {
    it.each(['CENTERIVO_ENV', 'APP_ENV', 'DEPLOYMENT_ENV', 'ENVIRONMENT'])(
      '%s=staging beats NODE_ENV=development',
      (name) => {
        for (const value of [
          'staging',
          'production',
          'prod',
          'live',
          ' Live ',
        ]) {
          expect(refuses({ ...LOCAL, [name]: value })).toBe(true);
          expect(refuses({ ...CI, [name]: value })).toBe(true);
        }
        // Benign values do not trigger it.
        expect(problems({ ...LOCAL, [name]: 'local' })).toEqual([]);
      },
    );

    it.each([undefined, '', 'dev', 'develop', 'qa', 'local', 'Development'])(
      'NODE_ENV=%j is not a safe development context',
      (nodeEnv) => {
        expect(devAuthContext({ ...LOCAL, NODE_ENV: nodeEnv })).toBeNull();
        expect(refuses({ ...LOCAL, NODE_ENV: nodeEnv })).toBe(true);
      },
    );

    it('production-like signals also refuse leftovers when no dev mode is requested', () => {
      expect(
        refuses({
          ...PRODUCTION,
          APP_ENV: 'production',
          ALLOW_DEV_AUTH: '1',
        }),
      ).toBe(true);
    });
  });

  describe('opt-in enforcement for local development', () => {
    it('is accepted only with NODE_ENV=development, ALLOW_DEV_AUTH=1 and a loopback database', () => {
      expect(problems(LOCAL)).toEqual([]);
      expect(devAuthContext(LOCAL)).toBe('local');
      for (const host of ['localhost', '127.0.0.1', '127.8.8.8', '[::1]']) {
        expect(
          devAuthContext({
            ...LOCAL,
            DATABASE_URL: `postgresql://u:p@${host}:5432/db`,
          }),
        ).toBe('local');
      }
    });

    it.each([undefined, '', '0', 'true', 'yes', '2'])(
      'ALLOW_DEV_AUTH=%j does not enable it',
      (value) => {
        expect(devAuthContext({ ...LOCAL, ALLOW_DEV_AUTH: value })).toBeNull();
        expect(refuses({ ...LOCAL, ALLOW_DEV_AUTH: value })).toBe(true);
      },
    );

    it('a non-loopback, unparsable or missing DATABASE_URL does not enable it', () => {
      for (const url of [
        'postgresql://u:p@db.internal:5432/db',
        'postgresql://u:p@10.0.0.5:5432/db',
        'postgresql://u:p@localhost.evil.example/db',
        'postgresql://u:p@localhost,db.internal:5432/db',
        'mysql://u:p@localhost/db',
        'not a url',
        '',
        undefined,
      ]) {
        expect(devAuthContext({ ...LOCAL, DATABASE_URL: url })).toBeNull();
      }
    });

    it('ALLOW_DEV_AUTH alone, or NODE_ENV=development alone, is not enough', () => {
      expect(
        devAuthContext({ NODE_ENV: 'development', AUTH_PROVIDER: 'dev' }),
      ).toBeNull();
      expect(
        devAuthContext({ ALLOW_DEV_AUTH: '1', AUTH_PROVIDER: 'dev' }),
      ).toBeNull();
    });

    it('a Cognito-mode local environment needs no opt-in and no dev secrets', () => {
      expect(
        problems({ NODE_ENV: 'development', AUTH_PROVIDER: 'cognito' }),
      ).toEqual([]);
      expect(problems({})).toEqual([]);
    });
  });

  describe('isolated tests keep working; a server started in a test context does not weaken startup', () => {
    it('the CI environment is still an isolated-test context for the request-time gates', () => {
      expect(devAuthContext(CI)).toBe('isolated-test');
      expect(
        devAuthContext({ ...CI, NODE_ENV: 'development', JEST_WORKER_ID: '1' }),
      ).toBe('isolated-test');
    });

    it('API startup refuses a copied CI configuration (public placeholder secrets)', () => {
      for (const env of [
        CI,
        { ...CI, NODE_ENV: 'development', JEST_WORKER_ID: '1' },
      ]) {
        expect(problems(env)).toEqual([
          expect.stringContaining(
            'AUTH_DEV_JWT_SECRET must not be a placeholder',
          ),
          expect.stringContaining(
            'INTERNAL_AUTH_DEV_JWT_SECRET must not be a placeholder',
          ),
        ]);
        expect(() => assertAuthConfigSafe(env)).toThrow(AuthConfigurationError);
      }
    });

    it('a test-context server starts only with credentials that meet the server requirements', () => {
      expect(problems(TEST_SERVER)).toEqual([]);
      expect(() => assertAuthConfigSafe(TEST_SERVER)).not.toThrow();
      expect(
        problems({
          ...TEST_SERVER,
          NODE_ENV: 'development',
          JEST_WORKER_ID: '1',
        }),
      ).toEqual([]);
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['short', 'ab'.repeat(15) + 'c'],
      ['one repeated character', 'x'.repeat(40)],
      ['a placeholder', 'changeme'],
      ['a published CI value', 'ci-customer-dev-secret-not-a-real-credential'],
    ])(
      'a %s dev secret is refused at startup in an isolated-test context',
      (_label, secret) => {
        expect(devAuthContext(TEST_SERVER)).toBe('isolated-test');
        expect(refuses({ ...TEST_SERVER, AUTH_DEV_JWT_SECRET: secret })).toBe(
          true,
        );
        expect(
          refuses({ ...TEST_SERVER, INTERNAL_AUTH_DEV_JWT_SECRET: secret }),
        ).toBe(true);
      },
    );

    it('one secret shared by both boundaries is refused at startup in a test context', () => {
      const shared = 'one-shared-dev-secret-for-both-boundaries-0000';
      expect(
        problems({
          ...TEST_SERVER,
          AUTH_DEV_JWT_SECRET: shared,
          INTERNAL_AUTH_DEV_JWT_SECRET: shared,
        }),
      ).toEqual([expect.stringContaining('must differ')]);
    });

    it('a copied CI environment cannot be rescued by the test declaration in a production-like environment', () => {
      for (const name of ['APP_ENV', 'CENTERIVO_ENV']) {
        const result = problems({ ...CI, [name]: 'staging' });
        expect(result.join(' ')).toMatch(/not allowed here/);
        expect(devAuthContext({ ...CI, [name]: 'staging' })).toBeNull();
      }
    });

    it.each([
      ['no test flag', { CENTERIVO_TEST_DATABASE: undefined }],
      ['a malformed token', { CENTERIVO_TEST_DB_TOKEN: 'short' }],
      ['no token', { CENTERIVO_TEST_DB_TOKEN: undefined }],
      ['development outside Jest', { NODE_ENV: 'development' }],
    ])(
      'an incomplete test declaration (%s) is not an isolated test',
      (_label, patch) => {
        expect(devAuthContext({ ...CI, ...patch })).toBeNull();
      },
    );

    it('the CI placeholder secrets are refused outside an isolated test', () => {
      const env = {
        ...LOCAL,
        AUTH_DEV_JWT_SECRET: CI.AUTH_DEV_JWT_SECRET,
        INTERNAL_AUTH_DEV_JWT_SECRET: CI.INTERNAL_AUTH_DEV_JWT_SECRET,
      };
      expect(problems(env)).toEqual([
        expect.stringContaining(
          'AUTH_DEV_JWT_SECRET must not be a placeholder',
        ),
        expect.stringContaining(
          'INTERNAL_AUTH_DEV_JWT_SECRET must not be a placeholder',
        ),
      ]);
    });
  });

  describe('provider modes and dev secrets', () => {
    it.each([
      'Dev',
      'DEV',
      ' dev',
      'dev ',
      'devv',
      'true',
      'cognito2',
      'Cognito',
    ])(
      'a mode value of %j is refused instead of silently selecting Cognito',
      (value) => {
        expect(refuses({ ...LOCAL, AUTH_PROVIDER: value })).toBe(true);
        expect(refuses({ ...LOCAL, INTERNAL_AUTH_PROVIDER: value })).toBe(true);
        expect(
          problems({ ...PRODUCTION, INTERNAL_AUTH_PROVIDER: value }),
        ).toEqual([expect.stringContaining('INTERNAL_AUTH_PROVIDER must be')]);
      },
    );

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['short', 'ab'.repeat(15) + 'c'],
      ['one repeated character', 'x'.repeat(40)],
      ['a placeholder', 'changeme'],
      ['a published CI value', 'ci-customer-dev-secret-for-local-use'],
    ])('a %s dev secret is refused for local dev auth', (_label, secret) => {
      expect(refuses({ ...LOCAL, AUTH_DEV_JWT_SECRET: secret })).toBe(true);
      expect(refuses({ ...LOCAL, INTERNAL_AUTH_DEV_JWT_SECRET: secret })).toBe(
        true,
      );
    });

    it('one secret shared by both boundaries is refused in every context', () => {
      const shared = 'one-shared-dev-secret-for-both-boundaries-0000';
      for (const base of [LOCAL, CI]) {
        expect(
          problems({
            ...base,
            AUTH_DEV_JWT_SECRET: shared,
            INTERNAL_AUTH_DEV_JWT_SECRET: shared,
          }),
        ).toEqual([expect.stringContaining('must differ')]);
      }
    });

    it('only the boundary that requested dev needs its secret', () => {
      expect(
        problems({
          ...LOCAL,
          AUTH_PROVIDER: 'cognito',
          AUTH_DEV_JWT_SECRET: undefined,
        }),
      ).toEqual([]);
    });
  });

  describe('production requirements', () => {
    it.each([
      ['AUTH_DEV_JWT_SECRET', CUSTOMER_SECRET],
      ['INTERNAL_AUTH_DEV_JWT_SECRET', INTERNAL_SECRET],
    ])('a leftover %s is refused even with Cognito selected', (name, value) => {
      expect(problems({ ...PRODUCTION, [name]: value })).toEqual([
        expect.stringContaining(`${name} must not be set`),
      ]);
      expect(
        problems({ ...PRODUCTION, AUTH_PROVIDER: 'cognito', [name]: value }),
      ).toHaveLength(1);
    });

    it('dev providers selected in production report the production signal', () => {
      const result = problems({ ...PRODUCTION, AUTH_PROVIDER: 'dev' });
      expect(result.join(' ')).toMatch(
        /NODE_ENV declares a production, staging or live environment/,
      );
    });

    it.each(Object.keys(COGNITO))(
      'a missing %s is refused in a production-like environment',
      (name) => {
        expect(problems({ ...PRODUCTION, [name]: undefined })).toEqual([
          expect.stringContaining(name),
        ]);
        expect(problems({ ...PRODUCTION, [name]: '  ' })).toHaveLength(1);
      },
    );

    it('ALLOW_DEV_AUTH must never be set in a production-like environment', () => {
      expect(problems({ ...PRODUCTION, ALLOW_DEV_AUTH: '1' })).toEqual([
        expect.stringContaining('ALLOW_DEV_AUTH must not be set'),
      ]);
    });

    it('Cognito ids are not demanded outside production-like environments', () => {
      expect(problems({ NODE_ENV: 'development' })).toEqual([]);
      expect(problems({ NODE_ENV: 'test' })).toEqual([]);
    });
  });

  describe('the simulated payment provider', () => {
    it('is refused at startup in every production-like environment', () => {
      for (const nodeEnv of ['production', 'staging', 'prod', 'live']) {
        expect(
          problems({
            ...PRODUCTION,
            NODE_ENV: nodeEnv,
            PAYMENT_PROVIDER: 'fake',
          }),
        ).toEqual([expect.stringContaining('PAYMENT_PROVIDER=fake')]);
      }
      expect(
        problems({ ...PRODUCTION, PAYMENT_PROVIDER: ' FAKE ' }),
      ).toHaveLength(1);
      // ESP-04 M2 — the two-step fake too.
      expect(
        problems({ ...PRODUCTION, PAYMENT_PROVIDER: 'fake-two-step' }),
      ).toEqual([expect.stringContaining('PAYMENT_PROVIDER=fake-two-step')]);
      expect(problems({ ...PRODUCTION, PAYMENT_PROVIDER: 'disabled' })).toEqual(
        [],
      );
    });

    it('is allowed locally and in tests', () => {
      expect(problems({ ...LOCAL, PAYMENT_PROVIDER: 'fake' })).toEqual([]);
      expect(problems({ ...LOCAL, PAYMENT_PROVIDER: 'fake-two-step' })).toEqual(
        [],
      );
      expect(problems(TEST_SERVER)).toEqual([]);
    });

    it('the request-time payment gate uses the same classifier', () => {
      for (const env of [
        { NODE_ENV: 'production' },
        { NODE_ENV: 'staging' },
        { NODE_ENV: 'development', APP_ENV: 'production' },
        { NODE_ENV: 'test', DEPLOYMENT_ENV: 'live' },
        { CENTERIVO_ENV: ' Staging ' },
      ]) {
        expect(() =>
          resolvePaymentProviderMode({ ...env, PAYMENT_PROVIDER: 'fake' }),
        ).toThrow(PaymentConfigurationError);
      }
      expect(
        resolvePaymentProviderMode({
          NODE_ENV: 'development',
          PAYMENT_PROVIDER: 'fake',
        }),
      ).toBe('fake');
      expect(
        resolvePaymentProviderMode({
          NODE_ENV: 'test',
          PAYMENT_PROVIDER: 'fake',
        }),
      ).toBe('fake');
      expect(resolvePaymentProviderMode({ NODE_ENV: 'staging' })).toBe(
        'unavailable',
      );
    });
  });

  describe('errors never reveal a secret or a connection string', () => {
    it('lists every problem at once, naming variables only', () => {
      const secret = 'Sup3r-S3cret-dev-value-that-must-not-leak-0000';
      const env: Env = {
        NODE_ENV: 'staging',
        AUTH_PROVIDER: 'dev',
        INTERNAL_AUTH_PROVIDER: 'Dev',
        AUTH_DEV_JWT_SECRET: secret,
        INTERNAL_AUTH_DEV_JWT_SECRET: secret,
        DATABASE_URL: `postgresql://admin:${secret}@db.example.test:5432/prod`,
        PAYMENT_PROVIDER: 'fake',
        ALLOW_DEV_AUTH: '1',
      };
      let error: unknown;
      try {
        assertAuthConfigSafe(env);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(AuthConfigurationError);
      const message = (error as AuthConfigurationError).message;
      expect((error as AuthConfigurationError).problems.length).toBeGreaterThan(
        4,
      );
      for (const forbidden of [secret, 'admin', 'db.example.test']) {
        expect(message).not.toContain(forbidden);
      }
      expect(message).toContain('AUTH_DEV_JWT_SECRET');
    });
  });

  describe('request-time gates agree with the startup decision', () => {
    const originalEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...originalEnv };
    });
    const withEnv = (env: Env) => {
      process.env = { ...env };
    };

    const grid = (): Env[] => {
      const envs: Env[] = [];
      const nodeEnvs = [
        undefined,
        '',
        'development',
        'test',
        'production',
        'staging',
        'prod',
        'live',
        'Production',
      ];
      const signals = [undefined, 'staging', 'production', 'local'];
      const allows = [undefined, '1'];
      const urls = [
        undefined,
        'postgresql://u:p@localhost:5432/db',
        'postgresql://u:p@db.internal:5432/db',
      ];
      const testFlags = [true, false];
      for (const NODE_ENV of nodeEnvs)
        for (const APP_ENV of signals)
          for (const ALLOW_DEV_AUTH of allows)
            for (const DATABASE_URL of urls)
              for (const declared of testFlags) {
                envs.push({
                  AUTH_PROVIDER: 'dev',
                  INTERNAL_AUTH_PROVIDER: 'dev',
                  AUTH_DEV_JWT_SECRET: CUSTOMER_SECRET,
                  INTERNAL_AUTH_DEV_JWT_SECRET: INTERNAL_SECRET,
                  NODE_ENV,
                  APP_ENV,
                  ALLOW_DEV_AUTH,
                  DATABASE_URL,
                  ...(declared
                    ? {
                        CENTERIVO_TEST_DATABASE: '1',
                        CENTERIVO_TEST_DB_TOKEN: 'a-valid-token-0123456789',
                        JEST_WORKER_ID: '1',
                      }
                    : {}),
                });
              }
      return envs;
    };

    it('whenever dev auth is requested, startup passes exactly when both request-time gates are on', () => {
      let allowed = 0;
      let refused = 0;
      for (const env of grid()) {
        // Strong, distinct secrets: the only thing decided is the context.
        const startupOk = problems(env).length === 0;
        withEnv(env);
        const customer = isDevCustomerAuthEnabled();
        const internal = isDevInternalAuthEnabled();
        expect([JSON.stringify(env), customer, internal]).toEqual([
          JSON.stringify(env),
          startupOk,
          startupOk,
        ]);
        if (startupOk) allowed += 1;
        else refused += 1;
      }
      // Both outcomes occur, so the comparison above is not vacuous.
      expect(allowed).toBeGreaterThan(0);
      expect(refused).toBeGreaterThan(0);
    });

    it('Jest keeps working: the request-time gates stay on for the CI environment although API startup refuses its placeholder secrets', () => {
      withEnv(CI);
      expect(isDevCustomerAuthEnabled()).toBe(true);
      expect(isDevInternalAuthEnabled()).toBe(true);
      expect(refuses(CI)).toBe(true);
      withEnv(TEST_SERVER);
      expect(isDevCustomerAuthEnabled()).toBe(true);
      expect(isDevInternalAuthEnabled()).toBe(true);
      expect(refuses(TEST_SERVER)).toBe(false);
    });

    it('never enables a gate without its own mode variable being exactly "dev"', () => {
      for (const mode of [undefined, '', 'cognito', 'Dev', ' dev']) {
        withEnv({
          ...LOCAL,
          AUTH_PROVIDER: mode,
          INTERNAL_AUTH_PROVIDER: mode,
        });
        expect(isDevCustomerAuthEnabled()).toBe(false);
        expect(isDevInternalAuthEnabled()).toBe(false);
      }
    });

    it('stays off for production, staging and an unset NODE_ENV even with the dev switch and opt-in', () => {
      for (const nodeEnv of ['production', 'staging', undefined]) {
        withEnv({ ...LOCAL, NODE_ENV: nodeEnv });
        expect(isDevCustomerAuthEnabled()).toBe(false);
        expect(isDevInternalAuthEnabled()).toBe(false);
      }
    });
  });

  describe('shared classifier (seed guard regression)', () => {
    it('the seed guard and the API use the very same production classifier', () => {
      expect(seedGuard.productionSignal).toBe(database.productionSignal);
      expect(seedGuard.isLoopbackHost).toBe(database.isLoopbackHost);
      for (const [env, expected] of [
        [{ NODE_ENV: 'staging' }, 'NODE_ENV'],
        [{ NODE_ENV: 'development', ENVIRONMENT: 'live' }, 'ENVIRONMENT'],
        [{ NODE_ENV: 'development' }, null],
        [{}, null],
      ] as Array<[Env, string | null]>) {
        expect(database.productionSignal(env)).toBe(expected);
      }
    });

    it('isDeclaredTestRun agrees with the disposable-database environment check', () => {
      const nodeEnvs = [undefined, 'test', 'development', 'production'];
      const flags = [undefined, '1', '0'];
      const tokens = [undefined, 'short', 'a-valid-token-0123456789'];
      const jest = [undefined, '1'];
      for (const NODE_ENV of nodeEnvs)
        for (const CENTERIVO_TEST_DATABASE of flags)
          for (const CENTERIVO_TEST_DB_TOKEN of tokens)
            for (const JEST_WORKER_ID of jest) {
              const env: Env = {
                NODE_ENV,
                CENTERIVO_TEST_DATABASE,
                CENTERIVO_TEST_DB_TOKEN,
                JEST_WORKER_ID,
              };
              let guardAccepts = true;
              try {
                assertTestEnvironment(env);
              } catch {
                guardAccepts = false;
              }
              expect([
                JSON.stringify(env),
                database.isDeclaredTestRun(env),
              ]).toEqual([JSON.stringify(env), guardAccepts]);
            }
    });
  });
});

// SC1a — the CENTERIVO platform-operator boundary joins the same fail-closed
// startup validation as the customer and tenant-staff boundaries.
describe('platform-operator boundary (SC1a)', () => {
  const PLATFORM_SECRET = 'platform-dev-secret-for-local-use-0003';
  const PLATFORM_POOL = {
    PLATFORM_COGNITO_USER_POOL_ID: 'us-east-1_plat789',
    PLATFORM_COGNITO_CLIENT_ID: 'platformclientid',
  };

  it('a local machine may opt the platform boundary into dev with its own strong secret', () => {
    expect(
      problems({
        ...LOCAL,
        PLATFORM_AUTH_PROVIDER: 'dev',
        PLATFORM_AUTH_DEV_JWT_SECRET: PLATFORM_SECRET,
      }),
    ).toEqual([]);
  });

  it('PLATFORM_AUTH_PROVIDER must be exactly "cognito" or "dev"', () => {
    expect(problems({ ...LOCAL, PLATFORM_AUTH_PROVIDER: 'Dev' })).toEqual([
      expect.stringContaining('PLATFORM_AUTH_PROVIDER must be exactly'),
    ]);
  });

  it.each(['AUTH_DEV_JWT_SECRET', 'INTERNAL_AUTH_DEV_JWT_SECRET'])(
    'the platform dev secret may not equal %s',
    (other) => {
      expect(
        problems({
          ...LOCAL,
          PLATFORM_AUTH_PROVIDER: 'dev',
          PLATFORM_AUTH_DEV_JWT_SECRET: LOCAL[other],
        }),
      ).toEqual([
        expect.stringMatching(
          new RegExp(`${other} and PLATFORM_AUTH_DEV_JWT_SECRET must differ`),
        ),
      ]);
    },
  );

  it('a weak or missing platform dev secret is refused', () => {
    expect(refuses({ ...LOCAL, PLATFORM_AUTH_PROVIDER: 'dev' })).toBe(true);
    expect(
      refuses({
        ...LOCAL,
        PLATFORM_AUTH_PROVIDER: 'dev',
        PLATFORM_AUTH_DEV_JWT_SECRET: 'short',
      }),
    ).toBe(true);
  });

  it('production can never select the dev platform provider, nor keep its secret', () => {
    const found = problems({
      ...PRODUCTION,
      ...PLATFORM_POOL,
      PLATFORM_AUTH_PROVIDER: 'dev',
      PLATFORM_AUTH_DEV_JWT_SECRET: PLATFORM_SECRET,
    });
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringContaining('PLATFORM_AUTH_PROVIDER=dev'),
        expect.stringContaining(
          'PLATFORM_AUTH_DEV_JWT_SECRET must not be set in a production-like environment',
        ),
      ]),
    );
    expect(found.join('\n')).not.toContain(PLATFORM_SECRET);
  });

  it('production starts without a platform pool (the platform routes fail closed instead), and with a dedicated one', () => {
    expect(problems(PRODUCTION)).toEqual([]);
    expect(problems({ ...PRODUCTION, ...PLATFORM_POOL })).toEqual([]);
  });

  it('a platform pool or client set without its pair is refused', () => {
    expect(
      problems({
        ...PRODUCTION,
        PLATFORM_COGNITO_USER_POOL_ID: 'us-east-1_plat789',
      }),
    ).toEqual([
      'PLATFORM_COGNITO_USER_POOL_ID and PLATFORM_COGNITO_CLIENT_ID must be set together.',
    ]);
  });

  it.each([
    ['COGNITO_USER_POOL_ID', 'PLATFORM_COGNITO_USER_POOL_ID'],
    ['INTERNAL_COGNITO_USER_POOL_ID', 'PLATFORM_COGNITO_USER_POOL_ID'],
    ['COGNITO_CLIENT_ID', 'PLATFORM_COGNITO_CLIENT_ID'],
    ['INTERNAL_COGNITO_CLIENT_ID', 'PLATFORM_COGNITO_CLIENT_ID'],
  ])(
    'a platform pool/client shared with %s is refused, in every environment',
    (other, platform) => {
      for (const base of [PRODUCTION, { ...COGNITO }]) {
        const env = { ...base, ...PLATFORM_POOL, [platform]: base[other] };
        expect(problems(env)).toEqual([
          `${platform} must differ from ${other}.`,
        ]);
      }
    },
  );
});

// SC1b — the dev platform sign-in's settings never reach production.
describe('platform-operator sign-in (SC1b)', () => {
  it.each([
    'PLATFORM_AUTH_DEV_TOTP_SECRET',
    'PLATFORM_AUTH_DEV_PASSWORD',
    'PLATFORM_AUTH_DEV_MFA_ENROLLMENT',
  ])('%s is refused in a production-like environment', (name) => {
    expect(problems({ ...PRODUCTION, [name]: 'JBSWY3DPEHPK3PXP' })).toEqual([
      `${name} must not be set in a production-like environment (NODE_ENV).`,
    ]);
  });

  it('a local machine may set them', () => {
    expect(
      problems({
        ...LOCAL,
        PLATFORM_AUTH_DEV_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
        PLATFORM_AUTH_DEV_PASSWORD: 'local-only-password',
        PLATFORM_AUTH_DEV_MFA_ENROLLMENT: '1',
      }),
    ).toEqual([]);
  });
});
