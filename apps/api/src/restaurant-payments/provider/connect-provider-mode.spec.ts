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

const KEY = 'sk_test_connectkey1234567890';
const SECRET = 'whsec_connectsecret1234567890ab';

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
      { STRIPE_CONNECT_SECRET_KEY: 'sk_live_abcdefghijklmnop' },
    ],
    [
      'a live restricted key',
      {
        RESTAURANT_PAYMENTS_PROVIDER: 'stripe',
        STRIPE_CONNECT_SECRET_KEY: 'rk_live_abcdefghijklmnop',
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
        STRIPE_CONNECT_SECRET_KEY: 'pk_test_abcdefghijklmnop',
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
