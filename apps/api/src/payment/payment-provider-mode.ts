import { productionSignal } from '@mocha-house/database';

// Payment safety — which payment provider this process binds, decided once
// at startup from configuration, fail-closed (the same convention as the
// development auth providers, auth-provider-mode.ts):
//   - PAYMENT_PROVIDER=fake selects the deterministic simulated provider,
//     and ONLY when no production-like signal is present (NODE_ENV or
//     CENTERIVO_ENV / APP_ENV / DEPLOYMENT_ENV / ENVIRONMENT set to
//     production, prod, staging or live) — an absolute floor, not
//     overridable. In such an environment it is a startup error: a
//     simulated payment would otherwise be recorded as paid.
//   - Unset (or "disabled") selects the unavailable provider: online
//     payment is refused before anything is recorded. This is the default
//     everywhere, so forgetting the variable can never turn simulated
//     payments on.
//   - Any other value is a startup error (there is no live processor yet).
// Error messages name the variable, never its value.
export type PaymentProviderMode = 'fake' | 'unavailable';

export class PaymentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentConfigurationError';
  }
}

export function resolvePaymentProviderMode(
  env: Record<string, string | undefined> = process.env,
): PaymentProviderMode {
  const value = env.PAYMENT_PROVIDER;
  if (value === undefined || value === '' || value === 'disabled') {
    return 'unavailable';
  }
  if (value === 'fake') {
    // The same production-like classifier as the startup validation and the
    // dev auth gates (config/dev-auth-context.ts): NODE_ENV and the
    // deployment variables, so "staging" or APP_ENV=production refuse too.
    if (productionSignal(env) !== null) {
      throw new PaymentConfigurationError(
        'PAYMENT_PROVIDER=fake is not allowed in production, staging or live environments: simulated payments would be recorded as paid. ' +
          'Leave PAYMENT_PROVIDER unset (online payment disabled) until a live payment provider is integrated.',
      );
    }
    return 'fake';
  }
  throw new PaymentConfigurationError(
    'PAYMENT_PROVIDER has an unsupported value. Use "fake" (development and tests only) or leave it unset to disable online payment.',
  );
}
