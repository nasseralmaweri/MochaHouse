import { createPaymentProvider } from './payment.module';
import {
  PaymentConfigurationError,
  resolvePaymentProviderMode,
  stripeCheckoutTenants,
} from './payment-provider-mode';
import { StripePaymentIntentProvider } from '../restaurant-payments/provider/stripe-payment-intent-provider';
import { paymentProviderLabel } from '../admin-platform/platform-presentation';
import { testOnly } from '../../test/fake-stripe-intents';

// ESP-04 M3 — PAYMENT_PROVIDER=stripe is Stripe TEST MODE only and refused
// unless its whole configuration is valid and separate: the M1 Connect
// configuration, a test publishable key, the payment-events endpoint's own
// signing secret (never the account-events or SaaS billing one), and a
// well-formed tenant allowlist (empty allows nobody). Live keys are refused
// whatever the mode, and nothing turns payments on by default.

const T1 = '01a0db02-f800-7000-8000-000000000001';
const whsec = (name: string) => `whsec_${name}${'A'.repeat(24)}`;

function stripeEnv(
  over: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'development',
    PAYMENT_PROVIDER: 'stripe',
    RESTAURANT_PAYMENTS_PROVIDER: 'stripe',
    STRIPE_CONNECT_SECRET_KEY: testOnly('sk_test'),
    STRIPE_CONNECT_WEBHOOK_SECRET: whsec('accounts'),
    STRIPE_CONNECT_PUBLISHABLE_KEY: testOnly('pk_test'),
    STRIPE_CONNECT_PAYMENTS_WEBHOOK_SECRET: whsec('payments'),
    RESTAURANT_CHECKOUT_PAYMENT_TENANTS: T1,
    ...over,
  };
}

describe('ESP-04 M3 Stripe payment configuration (payment safety)', () => {
  it('is off unless explicitly selected', () => {
    const env = stripeEnv({ PAYMENT_PROVIDER: undefined });
    expect(resolvePaymentProviderMode(env)).toBe('unavailable');
    expect(createPaymentProvider(env).acceptsPayments).toBe(false);
  });

  it('binds Stripe test mode with a valid, separate configuration', () => {
    const env = stripeEnv();
    expect(resolvePaymentProviderMode(env)).toBe('stripe');
    const provider = createPaymentProvider(env);
    expect(provider).toBeInstanceOf(StripePaymentIntentProvider);
    expect(provider.acceptsOneStepCharges).toBe(false);
    expect(paymentProviderLabel(provider)).toBe('Stripe (test mode)');
    expect((provider as StripePaymentIntentProvider).allowsTenant(T1)).toBe(
      true,
    );
  });

  it.each([
    ['production', { NODE_ENV: 'production' }],
    ['staging', { APP_ENV: 'staging' }],
    ['live deployment', { DEPLOYMENT_ENV: 'live' }],
    ['no Connect provider', { RESTAURANT_PAYMENTS_PROVIDER: undefined }],
    ['the fake Connect provider', { RESTAURANT_PAYMENTS_PROVIDER: 'fake' }],
    ['a live Connect key', { STRIPE_CONNECT_SECRET_KEY: 'sk_live_x' }],
    [
      'the billing key reused',
      { STRIPE_BILLING_SECRET_KEY: testOnly('sk_test') },
    ],
    ['no publishable key', { STRIPE_CONNECT_PUBLISHABLE_KEY: undefined }],
    [
      'a secret key as publishable key',
      { STRIPE_CONNECT_PUBLISHABLE_KEY: testOnly('sk_test') },
    ],
    [
      'no payments webhook secret',
      { STRIPE_CONNECT_PAYMENTS_WEBHOOK_SECRET: undefined },
    ],
    [
      'the account-events secret reused',
      { STRIPE_CONNECT_PAYMENTS_WEBHOOK_SECRET: whsec('accounts') },
    ],
    [
      'the billing webhook secret reused',
      { STRIPE_BILLING_WEBHOOK_SECRET: whsec('payments') },
    ],
    [
      'a malformed allowlist',
      { RESTAURANT_CHECKOUT_PAYMENT_TENANTS: `${T1},not-an-id` },
    ],
  ])('refuses to start with %s', (_label, over) => {
    expect(() => resolvePaymentProviderMode(stripeEnv(over))).toThrow(
      PaymentConfigurationError,
    );
  });

  it('refuses a live publishable key whatever the mode, and names no value', () => {
    for (const mode of [undefined, 'fake', 'stripe']) {
      let message = '';
      try {
        resolvePaymentProviderMode(
          stripeEnv({
            PAYMENT_PROVIDER: mode,
            STRIPE_CONNECT_PUBLISHABLE_KEY: 'pk_live_abcdefghijklmnop',
          }),
        );
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/live Stripe publishable key/);
      expect(message).not.toContain('abcdefghijklmnop');
    }
  });

  it('allows nobody when the allowlist is empty', () => {
    expect(stripeCheckoutTenants({})).toEqual(new Set());
    expect(
      stripeCheckoutTenants({ RESTAURANT_CHECKOUT_PAYMENT_TENANTS: ' ' }),
    ).toEqual(new Set());
    const provider = createPaymentProvider(
      stripeEnv({ RESTAURANT_CHECKOUT_PAYMENT_TENANTS: '' }),
    ) as StripePaymentIntentProvider;
    expect(provider.allowsTenant(T1)).toBe(false);
  });
});
