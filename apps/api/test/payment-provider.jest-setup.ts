// Unit and integration specs run the API against a disposable database
// with the simulated payment provider. Outside Jest the default is the
// fail-closed "unavailable" provider (see payment/payment-provider-mode.ts),
// so this opt-in is test-only. A spec that needs a different mode sets
// PAYMENT_PROVIDER itself before building its module.
process.env.PAYMENT_PROVIDER ??= 'fake';
