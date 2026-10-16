import { paymentMethodCase } from './billing-reconciliation.service';

// SC3b — reconciliation tells legitimate payment-method arrangements apart
// from real disagreements (the provider adapter already counts the
// subscription's own default AND the customer's default as "has one").
describe('reconciliation: payment methods', () => {
  const live = (
    status:
      'active' | 'trialing' | 'canceled' | 'incomplete_expired' | 'past_due',
    hasPaymentMethod: boolean,
  ) => ({
    status,
    hasPaymentMethod,
  });

  it('agreement is not a case: authorized with a method, or a cardless trial with none', () => {
    expect(paymentMethodCase(live('active', true), 'ACTIVE', true)).toBeNull();
    expect(
      paymentMethodCase(live('trialing', false), 'TRIALING', false),
    ).toBeNull();
  });

  it("an ended subscription (ours or the provider's) needs no payment method", () => {
    expect(
      paymentMethodCase(live('canceled', false), 'CANCELED', true),
    ).toBeNull();
    expect(
      paymentMethodCase(
        live('incomplete_expired', true),
        'TRIAL_EXPIRED',
        false,
      ),
    ).toBeNull();
    expect(
      paymentMethodCase(live('active', false), 'TRIAL_EXPIRED', true),
    ).toBeNull();
    expect(
      paymentMethodCase(live('active', true), 'CANCELED', false),
    ).toBeNull();
  });

  it('a method the provider will charge that we have not recorded is reviewed', () => {
    expect(paymentMethodCase(live('trialing', true), 'TRIALING', false)).toBe(
      'PAYMENT_METHOD_NOT_RECORDED',
    );
  });

  it('an authorization with nothing left to charge (method removed) is reviewed', () => {
    expect(paymentMethodCase(live('active', false), 'ACTIVE', true)).toBe(
      'PAYMENT_METHOD_MISSING',
    );
    expect(paymentMethodCase(live('past_due', false), 'PAST_DUE', true)).toBe(
      'PAYMENT_METHOD_MISSING',
    );
  });
});
