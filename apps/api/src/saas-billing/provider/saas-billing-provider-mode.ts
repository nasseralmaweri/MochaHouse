import { productionSignal } from '@mocha-house/database';
import { FakeSaasBillingProvider } from './fake-saas-billing-provider';
import {
  DisabledSaasBillingProvider,
  type SaasBillingProvider,
} from './saas-billing-provider';

// SC3a — which SaaS billing provider this process binds, decided once at
// startup from SAAS_BILLING_PROVIDER (a variable of its own: it never
// shares configuration with the restaurant PAYMENT_PROVIDER).
//   unset / "disabled"  no billing provider (the default)
//   "fake"              the in-memory fake — development and tests ONLY;
//                       refused in production, staging or live environments
// Anything else (including "stripe", which arrives in SC3b) is refused.

export type SaasBillingProviderMode = 'disabled' | 'fake';

export class SaasBillingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaasBillingConfigurationError';
  }
}

export function resolveSaasBillingProviderMode(
  env: Record<string, string | undefined> = process.env,
): SaasBillingProviderMode {
  const value = env.SAAS_BILLING_PROVIDER;
  if (value === undefined || value === '' || value === 'disabled') {
    return 'disabled';
  }
  if (value === 'fake') {
    if (productionSignal(env) !== null) {
      throw new SaasBillingConfigurationError(
        'SAAS_BILLING_PROVIDER=fake is not allowed in production, staging or live environments.',
      );
    }
    return 'fake';
  }
  throw new SaasBillingConfigurationError(
    'SAAS_BILLING_PROVIDER has an unsupported value. Use "fake" (development and tests only) or leave it unset.',
  );
}

export function createSaasBillingProvider(
  env: Record<string, string | undefined> = process.env,
): SaasBillingProvider {
  return resolveSaasBillingProviderMode(env) === 'fake'
    ? new FakeSaasBillingProvider()
    : new DisabledSaasBillingProvider();
}
