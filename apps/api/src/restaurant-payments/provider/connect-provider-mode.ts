import { productionSignal } from '@mocha-house/database';
import {
  DisabledConnectAccountProvider,
  type ConnectAccountProvider,
} from './connect-account-provider';
import { FakeConnectAccountProvider } from './fake-connect-account-provider';
import { StripeConnectAccountProvider } from './stripe-connect-account-provider';

// ESP-04 M1 — which restaurant-payments (Stripe Connect) provider this process
// binds, decided once at startup from variables of its OWN. It never shares
// configuration with CENTERIVO's SaaS billing (SAAS_BILLING_PROVIDER /
// STRIPE_BILLING_*) nor with the checkout's PAYMENT_PROVIDER, and binding it
// enables no customer payment.
//   RESTAURANT_PAYMENTS_PROVIDER
//     unset / "disabled"   no provider (the default)
//     "fake"               the in-memory fake — development and tests ONLY
//     "stripe"             Stripe Connect, TEST MODE ONLY:
//       STRIPE_CONNECT_SECRET_KEY      sk_test_… or rk_test_… (a restricted
//                                      key is recommended); never the SaaS
//                                      billing key
//       STRIPE_CONNECT_WEBHOOK_SECRET  whsec_… of the Connect webhook
//                                      endpoint; never the billing one
//   PAYMENTS_CONNECT_RETURN_URL        the admin Payments page (server
//                                      configuration only, never a client
//                                      value)
//   PAYMENTS_CONNECT_COUNTRY           two-letter country (default "US")
// "fake" and "stripe" are refused in production, staging or live
// environments, and a live key is refused everywhere.

export type ConnectProviderMode = 'disabled' | 'fake' | 'stripe';

export class ConnectConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectConfigurationError';
  }
}

const TEST_SECRET_KEY = /^(sk|rk)_test_[A-Za-z0-9]{10,200}$/;
const LIVE_SECRET_KEY = /^(sk|rk)_live_/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=]{20,200}$/;
const COUNTRY = /^[A-Z]{2}$/;
// Development and tests only; refused outside them by the mode check.
export const FAKE_CONNECT_WEBHOOK_SECRET = 'fake-connect-webhook-secret';

export function resolveConnectProviderMode(
  env: Record<string, string | undefined> = process.env,
): ConnectProviderMode {
  // A live key is refused whatever the mode, so it can never be picked up by
  // accident.
  if (LIVE_SECRET_KEY.test(env.STRIPE_CONNECT_SECRET_KEY ?? '')) {
    throw new ConnectConfigurationError(
      'A live Stripe key is not allowed: restaurant payments run in Stripe test mode only.',
    );
  }
  const value = env.RESTAURANT_PAYMENTS_PROVIDER;
  if (value === undefined || value === '' || value === 'disabled') {
    return 'disabled';
  }
  if (value !== 'fake' && value !== 'stripe') {
    throw new ConnectConfigurationError(
      'RESTAURANT_PAYMENTS_PROVIDER has an unsupported value. Use "stripe" (test mode) or "fake" (development and tests), or leave it unset.',
    );
  }
  if (productionSignal(env) !== null) {
    throw new ConnectConfigurationError(
      `RESTAURANT_PAYMENTS_PROVIDER=${value} is not allowed in production, staging or live environments.`,
    );
  }
  if (value === 'stripe') {
    const key = env.STRIPE_CONNECT_SECRET_KEY ?? '';
    const secret = env.STRIPE_CONNECT_WEBHOOK_SECRET ?? '';
    if (!TEST_SECRET_KEY.test(key)) {
      throw new ConnectConfigurationError(
        'STRIPE_CONNECT_SECRET_KEY must be a Stripe TEST secret or restricted key (sk_test_… or rk_test_…).',
      );
    }
    if (!WEBHOOK_SECRET.test(secret)) {
      throw new ConnectConfigurationError(
        'STRIPE_CONNECT_WEBHOOK_SECRET must be a Stripe webhook signing secret (whsec_…).',
      );
    }
    // Restaurant payments and SaaS billing never share credentials.
    if (key === env.STRIPE_BILLING_SECRET_KEY) {
      throw new ConnectConfigurationError(
        'STRIPE_CONNECT_SECRET_KEY must not be the SaaS billing key: use a separate (restricted) key for restaurant payments.',
      );
    }
    if (secret === env.STRIPE_BILLING_WEBHOOK_SECRET) {
      throw new ConnectConfigurationError(
        'STRIPE_CONNECT_WEBHOOK_SECRET must not be the SaaS billing webhook secret: use a separate Connect webhook endpoint.',
      );
    }
  }
  return value;
}

export function createConnectAccountProvider(
  env: Record<string, string | undefined> = process.env,
): ConnectAccountProvider {
  const mode = resolveConnectProviderMode(env);
  if (mode === 'stripe') {
    return StripeConnectAccountProvider.create(env.STRIPE_CONNECT_SECRET_KEY!, {
      webhookSecret: env.STRIPE_CONNECT_WEBHOOK_SECRET!,
    });
  }
  if (mode === 'fake') {
    return new FakeConnectAccountProvider(FAKE_CONNECT_WEBHOOK_SECRET);
  }
  return new DisabledConnectAccountProvider();
}

// The admin Payments page Stripe returns the owner to. Server configuration
// only — never a client value.
export function connectReturnUrl(
  env: Record<string, string | undefined> = process.env,
): URL | null {
  const raw = env.PAYMENTS_CONNECT_RETURN_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:') return url;
    // Plain http only for local development and tests.
    const local = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
    return local && url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

export function connectCountry(
  env: Record<string, string | undefined> = process.env,
): string {
  const value = (env.PAYMENTS_CONNECT_COUNTRY ?? 'US').trim().toUpperCase();
  return COUNTRY.test(value) ? value : 'US';
}
