import {
  ConnectConfigurationError,
  connectCountry,
  connectReturnUrl,
  createConnectAccountProvider,
  resolveConnectProviderMode,
} from './connect-provider-mode';
import { DisabledConnectAccountProvider } from './connect-account-provider';
import { FakeConnectAccountProvider } from './fake-connect-account-provider';
import { StripeConnectAccountProvider } from './stripe-connect-account-provider';

// ESP-04 M1 — the restaurant-payments (Connect) provider is configured on
// its own, test mode only, never in production, and never with SaaS
// billing's credentials.

// Test-only stand-ins in Stripe's credential FORMATS (the resolver validates
// formats), assembled at run time so no complete credential-shaped string
// exists in source. Each is visibly fake ("TESTONLY") and can never be a
// valid Stripe credential.
const fake = (prefix: string): string => `${prefix}_${'TESTONLY'.repeat(3)}`;
const KEY = fake('sk_test');
const SECRET = fake('whsec');

describe('ESP-04 M1 Connect provider mode', () => {
  it('is disabled unless configured', () => {
    expect(resolveConnectProviderMode({})).toBe('disabled');
    expect(
      resolveConnectProviderMode({ RESTAURANT_PAYMENTS_PROVIDER: 'disabled' }),
    ).toBe('disabled');
    expect(createConnectAccountProvider({})).toBeInstanceOf(
      DisabledConnectAccountProvider,
    );
    expect(createConnectAccountProvider({}).available).toBe(false);
  });

  it('binds the fake in development and Stripe (test mode) when fully configured', () => {
    expect(
      createConnectAccountProvider({ RESTAURANT_PAYMENTS_PROVIDER: 'fake' }),
    ).toBeInstanceOf(FakeConnectAccountProvider);
    const stripe = createConnectAccountProvider({
      RESTAURANT_PAYMENTS_PROVIDER: 'stripe',
      STRIPE_CONNECT_SECRET_KEY: KEY,
      STRIPE_CONNECT_WEBHOOK_SECRET: SECRET,
    });
    expect(stripe).toBeInstanceOf(StripeConnectAccountProvider);
    expect(stripe.livemode).toBe(false);
  });

  it.each([
    [
      'a live secret key, in any mode',
      { STRIPE_CONNECT_SECRET_KEY: fake('sk_live') },
    ],
    [
      'a live restricted key',
      {
        RESTAURANT_PAYMENTS_PROVIDER: 'stripe',
        STRIPE_CONNECT_SECRET_KEY: fake('rk_live'),
      },
    ],
    ['an unknown mode', { RESTAURANT_PAYMENTS_PROVIDER: 'paypal' }],
    [
      'the fake in production',
      { RESTAURANT_PAYMENTS_PROVIDER: 'fake', NODE_ENV: 'production' },
    ],
    [
      'Stripe in production',
      {
        RESTAURANT_PAYMENTS_PROVIDER: 'stripe',
        NODE_ENV: 'production',
        STRIPE_CONNECT_SECRET_KEY: KEY,
        STRIPE_CONNECT_WEBHOOK_SECRET: SECRET,
      },
    ],
    [
      'a missing key',
      {
        RESTAURANT_PAYMENTS_PROVIDER: 'stripe',
        STRIPE_CONNECT_WEBHOOK_SECRET: SECRET,
      },
    ],
    [
      'a publishable key',
      {
        RESTAURANT_PAYMENTS_PROVIDER: 'stripe',
        STRIPE_CONNECT_SECRET_KEY: fake('pk_test'),
        STRIPE_CONNECT_WEBHOOK_SECRET: SECRET,
      },
    ],
    [
      'a missing webhook secret',
      {
        RESTAURANT_PAYMENTS_PROVIDER: 'stripe',
        STRIPE_CONNECT_SECRET_KEY: KEY,
      },
    ],
    [
      'the SaaS billing key',
      {
        RESTAURANT_PAYMENTS_PROVIDER: 'stripe',
        STRIPE_CONNECT_SECRET_KEY: KEY,
        STRIPE_CONNECT_WEBHOOK_SECRET: SECRET,
        STRIPE_BILLING_SECRET_KEY: KEY,
      },
    ],
    [
      'the SaaS billing webhook secret',
      {
        RESTAURANT_PAYMENTS_PROVIDER: 'stripe',
        STRIPE_CONNECT_SECRET_KEY: KEY,
        STRIPE_CONNECT_WEBHOOK_SECRET: SECRET,
        STRIPE_BILLING_WEBHOOK_SECRET: SECRET,
      },
    ],
  ])('refuses %s', (_label, env) => {
    expect(() => resolveConnectProviderMode(env)).toThrow(
      ConnectConfigurationError,
    );
  });

  it('takes the return page and country from server configuration only', () => {
    expect(connectReturnUrl({})).toBeNull();
    expect(
      connectReturnUrl({ PAYMENTS_CONNECT_RETURN_URL: 'javascript:alert(1)' }),
    ).toBeNull();
    expect(
      connectReturnUrl({
        PAYMENTS_CONNECT_RETURN_URL: 'https://u:p@admin.example.com/x',
      }),
    ).toBeNull();
    // Plain http only for local development and tests.
    expect(
      connectReturnUrl({
        PAYMENTS_CONNECT_RETURN_URL: 'http://admin.example.com/admin/payments',
      }),
    ).toBeNull();
    expect(
      connectReturnUrl({
        PAYMENTS_CONNECT_RETURN_URL: 'http://localhost:3000/admin/payments',
        NODE_ENV: 'development',
      }),
    ).not.toBeNull();
    expect(
      connectReturnUrl({
        PAYMENTS_CONNECT_RETURN_URL: 'https://admin.example.com/admin/payments',
      })?.toString(),
    ).toBe('https://admin.example.com/admin/payments');
    expect(connectCountry({})).toBe('US');
    expect(connectCountry({ PAYMENTS_CONNECT_COUNTRY: 'ca' })).toBe('CA');
    expect(connectCountry({ PAYMENTS_CONNECT_COUNTRY: 'nowhere' })).toBe('US');
  });
});
