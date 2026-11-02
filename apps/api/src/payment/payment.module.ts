import { Logger, Module } from '@nestjs/common';
import {
  FakePaymentProvider,
  FakeTwoStepPaymentProvider,
  UnavailablePaymentProvider,
  type PaymentProvider,
} from '@mocha-house/integrations';
import { PAYMENT_PROVIDER } from './payment-provider.token';
import { resolvePaymentProviderMode } from './payment-provider-mode';

// The single binding of the payment boundary (Milestone 7H). CheckoutService
// (food orders) and GiftCardPurchaseService (gift-card purchases) both depend
// only on the PaymentProvider interface via PAYMENT_PROVIDER; keeping the
// binding in its own module lets both consume it without OrdersModule and
// GiftCardsModule importing each other.
//
// Payment safety — the provider is chosen from configuration at startup
// (payment-provider-mode.ts): the simulated provider only when explicitly
// requested outside production; otherwise online payment is unavailable.
// An invalid configuration stops the process from starting.
export function createPaymentProvider(
  env: Record<string, string | undefined> = process.env,
): PaymentProvider {
  const mode = resolvePaymentProviderMode(env);
  if (mode === 'fake') {
    return new FakePaymentProvider();
  }
  // ESP-04 M2 — two-step food-order payments (intent + customer confirmation);
  // gift-card purchases still use its one-step charge.
  if (mode === 'fake-two-step') {
    return new FakeTwoStepPaymentProvider();
  }
  new Logger('PaymentModule').warn(
    'No payment provider is configured: online payment is disabled.',
  );
  return new UnavailablePaymentProvider();
}

@Module({
  providers: [
    { provide: PAYMENT_PROVIDER, useFactory: () => createPaymentProvider() },
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentModule {}
