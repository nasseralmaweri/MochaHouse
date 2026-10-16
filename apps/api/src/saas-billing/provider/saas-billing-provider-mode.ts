import { productionSignal } from '@mocha-house/database';
import { FakeSaasBillingProvider } from './fake-saas-billing-provider';
import {
  DisabledSaasBillingProvider,
  type SaasBillingProvider,
} from './saas-billing-provider';
import { StripeSaasBillingProvider } from './stripe-saas-billing-provider';

// SC3a/SC3b — which SaaS billing provider this process binds, decided once at
// startup from SAAS_BILLING_PROVIDER (variables of its own: it never shares
// configuration with the restaurant PAYMENT_PROVIDER).
//   unset / "disabled"  no billing provider (the default)
//   "fake"              the in-memory fake — development and tests ONLY
//   "stripe"            Stripe Billing, TEST MODE ONLY (SC3b, F4):
//                         STRIPE_BILLING_SECRET_KEY  sk_test_… or rk_test_…
//                         STRIPE_BILLING_WEBHOOK_SECRET  whsec_…
// Both "fake" and "stripe" are refused in production, staging or live
// environments (production billing stays disabled), and any live key is
// refused everywhere. Anything else is refused.

export type SaasBillingProviderMode = 'disabled' | 'fake' | 'stripe';

export class SaasBillingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaasBillingConfigurationError';
  }
}

const TEST_SECRET_KEY = /^(sk|rk)_test_[A-Za-z0-9]{10,200}$/;
const LIVE_SECRET_KEY = /^(sk|rk)_live_/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=]{20,200}$/;

export function resolveSaasBillingProviderMode(
  env: Record<string, string | undefined> = process.env,
): SaasBillingProviderMode {
  // A live key is refused whatever the mode, so it can never be picked up
  // by accident.
  if (LIVE_SECRET_KEY.test(env.STRIPE_BILLING_SECRET_KEY ?? '')) {
    throw new SaasBillingConfigurationError(
      'A live Stripe key is not allowed: SaaS billing runs in Stripe test mode only.',
    );
  }
  const value = env.SAAS_BILLING_PROVIDER;
  if (value === undefined || value === '' || value === 'disabled') {
    return 'disabled';
  }
  if (value !== 'fake' && value !== 'stripe') {
    throw new SaasBillingConfigurationError(
      'SAAS_BILLING_PROVIDER has an unsupported value. Use "stripe" (test mode) or "fake" (development and tests), or leave it unset.',
    );
  }
  if (productionSignal(env) !== null) {
    throw new SaasBillingConfigurationError(
      `SAAS_BILLING_PROVIDER=${value} is not allowed in production, staging or live environments.`,
    );
  }
  if (value === 'stripe') {
    if (!TEST_SECRET_KEY.test(env.STRIPE_BILLING_SECRET_KEY ?? '')) {
      throw new SaasBillingConfigurationError(
        'STRIPE_BILLING_SECRET_KEY must be a Stripe TEST secret or restricted key (sk_test_… or rk_test_…).',
      );
    }
    if (!WEBHOOK_SECRET.test(env.STRIPE_BILLING_WEBHOOK_SECRET ?? '')) {
      throw new SaasBillingConfigurationError(
        'STRIPE_BILLING_WEBHOOK_SECRET must be a Stripe webhook signing secret (whsec_…).',
      );
    }
  }
  return value;
}

function portalSetting(
  value: string | undefined,
  pattern: RegExp,
): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

export function createSaasBillingProvider(
  env: Record<string, string | undefined> = process.env,
): SaasBillingProvider {
  switch (resolveSaasBillingProviderMode(env)) {
    case 'fake':
      return new FakeSaasBillingProvider();
    case 'stripe':
      return StripeSaasBillingProvider.create(env.STRIPE_BILLING_SECRET_KEY!, {
        webhookSecret: env.STRIPE_BILLING_WEBHOOK_SECRET!,
        // SC3c-2 — the portal is offered only with both set (checked
        // against the provider before every session).
        portalConfigurationId: portalSetting(
          env.STRIPE_BILLING_PORTAL_CONFIGURATION,
          /^bpc_[A-Za-z0-9]{8,64}$/,
        ),
        expectedAccountId: portalSetting(
          env.STRIPE_BILLING_ACCOUNT_ID,
          /^acct_[A-Za-z0-9]{8,64}$/,
        ),
      });
    default:
      return new DisabledSaasBillingProvider();
  }
}
