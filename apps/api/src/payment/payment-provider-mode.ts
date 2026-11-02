import { productionSignal } from '@mocha-house/database';
import { resolveConnectProviderMode } from '../restaurant-payments/provider/connect-provider-mode';

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
// ESP-04 M2 — 'fake-two-step': the development fake that takes food-order
// payments in two steps (create an intent, the customer confirms, the server
// checks the provider), for exercising the two-step checkout. Development
// and tests only, exactly like 'fake'.
// ESP-04 M3 — 'stripe': restaurant customer payments through Stripe
// PaymentIntents (direct charges on the restaurant's connected account),
// STRIPE TEST MODE ONLY. Refused unless every one of these holds:
//   - no production-like signal (the same floor as the fakes);
//   - RESTAURANT_PAYMENTS_PROVIDER=stripe with a valid TEST Connect key (the
//     M1 validation, which also refuses live keys and billing-key reuse) —
//     intents are created with that platform key on the connected account;
//   - STRIPE_CONNECT_PUBLISHABLE_KEY            pk_test_…
//   - STRIPE_CONNECT_PAYMENTS_WEBHOOK_SECRET    whsec_… of the payment-events
//     endpoint (B1), different from the M1 account-events secret and from
//     the SaaS billing secret;
//   - RESTAURANT_CHECKOUT_PAYMENT_TENANTS       (B2) comma-separated business
//     ids allowed to take test payments; empty or unset allows NONE.
// A live publishable key is refused whatever the mode.
export type PaymentProviderMode =
  'fake' | 'fake-two-step' | 'stripe' | 'unavailable';

export class PaymentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentConfigurationError';
  }
}

const TEST_PUBLISHABLE_KEY = /^pk_test_[A-Za-z0-9]{10,200}$/;
const LIVE_PUBLISHABLE_KEY = /^pk_live_/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=]{20,200}$/;
const TENANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function resolvePaymentProviderMode(
  env: Record<string, string | undefined> = process.env,
): PaymentProviderMode {
  // A live key is refused whatever the mode, so it can never be picked up by
  // accident.
  if (LIVE_PUBLISHABLE_KEY.test(env.STRIPE_CONNECT_PUBLISHABLE_KEY ?? '')) {
    throw new PaymentConfigurationError(
      'A live Stripe publishable key is not allowed: restaurant payments run in Stripe test mode only.',
    );
  }
  const value = env.PAYMENT_PROVIDER;
  if (value === undefined || value === '' || value === 'disabled') {
    return 'unavailable';
  }
  if (value === 'fake' || value === 'fake-two-step') {
    // The same production-like classifier as the startup validation and the
    // dev auth gates (config/dev-auth-context.ts): NODE_ENV and the
    // deployment variables, so "staging" or APP_ENV=production refuse too.
    if (productionSignal(env) !== null) {
      throw new PaymentConfigurationError(
        `PAYMENT_PROVIDER=${value} is not allowed in production, staging or live environments: simulated payments would be recorded as paid. ` +
          'Leave PAYMENT_PROVIDER unset (online payment disabled) until a live payment provider is integrated.',
      );
    }
    return value;
  }
  if (value === 'stripe') {
    assertStripePaymentsConfiguration(env);
    return value;
  }
  throw new PaymentConfigurationError(
    'PAYMENT_PROVIDER has an unsupported value. Use "stripe" (Stripe test mode), "fake" or "fake-two-step" (development and tests only), or leave it unset to disable online payment.',
  );
}

function assertStripePaymentsConfiguration(
  env: Record<string, string | undefined>,
): void {
  if (productionSignal(env) !== null) {
    throw new PaymentConfigurationError(
      'PAYMENT_PROVIDER=stripe is not allowed in production, staging or live environments: restaurant payments run in Stripe test mode only.',
    );
  }
  // The M1 Connect configuration (test key, webhook secret, no billing
  // reuse), validated by its own resolver. Its message names no value.
  let connect: string;
  try {
    connect = resolveConnectProviderMode(env);
  } catch (error) {
    throw new PaymentConfigurationError(
      `PAYMENT_PROVIDER=stripe needs a valid restaurant-payments (Stripe Connect) test configuration: ${
        error instanceof Error ? error.message : 'invalid'
      }`,
    );
  }
  if (connect !== 'stripe') {
    throw new PaymentConfigurationError(
      "PAYMENT_PROVIDER=stripe needs RESTAURANT_PAYMENTS_PROVIDER=stripe: payments are taken on the restaurants' connected accounts.",
    );
  }
  if (!TEST_PUBLISHABLE_KEY.test(env.STRIPE_CONNECT_PUBLISHABLE_KEY ?? '')) {
    throw new PaymentConfigurationError(
      'STRIPE_CONNECT_PUBLISHABLE_KEY must be a Stripe TEST publishable key (pk_test_…).',
    );
  }
  const secret = env.STRIPE_CONNECT_PAYMENTS_WEBHOOK_SECRET ?? '';
  if (!WEBHOOK_SECRET.test(secret)) {
    throw new PaymentConfigurationError(
      'STRIPE_CONNECT_PAYMENTS_WEBHOOK_SECRET must be a Stripe webhook signing secret (whsec_…).',
    );
  }
  if (
    secret === env.STRIPE_CONNECT_WEBHOOK_SECRET ||
    secret === env.STRIPE_BILLING_WEBHOOK_SECRET
  ) {
    throw new PaymentConfigurationError(
      'STRIPE_CONNECT_PAYMENTS_WEBHOOK_SECRET must belong to its own payment-events endpoint: not the account-events or SaaS billing secret.',
    );
  }
  stripeCheckoutTenants(env);
}

// B2 — the businesses allowed to take Stripe test payments. Empty or unset:
// none. Any entry that is not a business id is a startup error.
export function stripeCheckoutTenants(
  env: Record<string, string | undefined> = process.env,
): ReadonlySet<string> {
  const raw = (env.RESTAURANT_CHECKOUT_PAYMENT_TENANTS ?? '').trim();
  if (raw === '') return new Set();
  const ids = raw.split(',').map((part) => part.trim().toLowerCase());
  if (ids.some((id) => !TENANT_ID.test(id))) {
    throw new PaymentConfigurationError(
      'RESTAURANT_CHECKOUT_PAYMENT_TENANTS must be a comma-separated list of business ids.',
    );
  }
  return new Set(ids);
}
