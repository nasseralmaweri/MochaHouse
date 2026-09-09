import { Module } from '@nestjs/common';
import { FakePaymentProvider } from '@mocha-house/integrations';
import { PAYMENT_PROVIDER } from './payment-provider.token';

// The single binding of the payment boundary (Milestone 7H). CheckoutService
// (food orders) and GiftCardPurchaseService (gift-card purchases) both depend
// only on the PaymentProvider interface via PAYMENT_PROVIDER; keeping the
// binding in its own module lets both consume it without OrdersModule and
// GiftCardsModule importing each other. Swapping in a real processor is a
// one-line change here, nowhere else.
@Module({
  providers: [{ provide: PAYMENT_PROVIDER, useClass: FakePaymentProvider }],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentModule {}
