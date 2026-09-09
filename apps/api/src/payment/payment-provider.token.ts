// DI token for the payment boundary. Consumers depend on this token and the
// PaymentProvider interface only — never on FakePaymentProvider by name — so
// a real processor can be bound in PaymentModule later with no change to any
// orchestration. Milestone 7H moved the binding here (into its own
// PaymentModule) so both OrdersModule (checkout) and GiftCardsModule
// (gift-card purchase) can share it without a module cycle.
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
