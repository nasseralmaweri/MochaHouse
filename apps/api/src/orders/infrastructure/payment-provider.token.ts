// DI token for the payment boundary. CheckoutService depends on this token
// and the PaymentProvider interface only — never on FakePaymentProvider by
// name — so a real processor can be bound here later with no change to
// checkout orchestration.
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
