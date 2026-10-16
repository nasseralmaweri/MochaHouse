import {
  portalConfigurationRefusal,
  type ProviderPortalConfiguration,
} from './portal-configuration';

// SC3c-2 — the Customer Portal is offered only under the operator's
// test-mode configuration, on the expected account, that updates payment
// methods and shows invoices — and can change nothing else.
describe('Customer Portal configuration check', () => {
  const expected = {
    configurationId: 'bpc_test0000000001',
    accountId: 'acct_test000000001',
  };
  const safe: ProviderPortalConfiguration = {
    ...expected,
    livemode: false,
    active: true,
    paymentMethodUpdate: true,
    invoiceHistory: true,
    subscriptionCancel: false,
    subscriptionUpdate: false,
    customerUpdate: false,
    loginPage: false,
    otherEnabledFeatures: [],
  };

  it('accepts the safe configuration', () => {
    expect(portalConfigurationRefusal(safe, expected)).toBeNull();
    // Invoice history is allowed, not required.
    expect(
      portalConfigurationRefusal({ ...safe, invoiceHistory: false }, expected),
    ).toBeNull();
  });

  it('refuses anything else, with the reason', () => {
    const cases: Array<[Partial<ProviderPortalConfiguration>, string]> = [
      [{ configurationId: 'bpc_other000000001' }, 'NOT_CONFIGURED'],
      [{ accountId: 'acct_other00000001' }, 'WRONG_ACCOUNT'],
      [{ livemode: true }, 'LIVE_MODE'],
      [{ active: false }, 'INACTIVE'],
      [{ paymentMethodUpdate: false }, 'NO_PAYMENT_METHOD_UPDATE'],
      [{ subscriptionCancel: true }, 'ALLOWS_SUBSCRIPTION_CHANGES'],
      [{ subscriptionUpdate: true }, 'ALLOWS_SUBSCRIPTION_CHANGES'],
      [{ customerUpdate: true }, 'ALLOWS_CUSTOMER_UPDATES'],
      [{ loginPage: true }, 'LOGIN_PAGE_ENABLED'],
      // e.g. pausing: anything not explicitly allowed.
      [
        { otherEnabledFeatures: ['subscription_pause'] },
        'ALLOWS_OTHER_FEATURES',
      ],
    ];
    for (const [change, reason] of cases) {
      expect(portalConfigurationRefusal({ ...safe, ...change }, expected)).toBe(
        reason,
      );
    }
  });
});
