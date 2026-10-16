// The account check proves the API key's account is the expected one; a
// configuration read with that key necessarily belongs to it.
//
// SC3c-2 — the Customer Portal is offered ONLY under an operator-configured,
// test-mode portal configuration that lets the owner update the payment
// method (and see invoices) and NOTHING that changes the subscription
// outside our lifecycle: no cancellation, no plan changes, no customer
// detail edits, no shareable login page. Checked before every session.

export interface ProviderPortalConfiguration {
  configurationId: string;
  // The provider account the configuration (and our key) belongs to.
  accountId: string;
  livemode: boolean;
  active: boolean;
  paymentMethodUpdate: boolean;
  invoiceHistory: boolean;
  subscriptionCancel: boolean;
  subscriptionUpdate: boolean;
  customerUpdate: boolean;
  loginPage: boolean;
  // Every OTHER enabled feature the provider reports (e.g. pausing a
  // subscription): any of them refuses the configuration (allow-list).
  otherEnabledFeatures: string[];
}

export type PortalConfigurationRefusal =
  | 'NOT_CONFIGURED'
  | 'WRONG_ACCOUNT'
  | 'LIVE_MODE'
  | 'INACTIVE'
  | 'NO_PAYMENT_METHOD_UPDATE'
  | 'ALLOWS_SUBSCRIPTION_CHANGES'
  | 'ALLOWS_CUSTOMER_UPDATES'
  | 'ALLOWS_OTHER_FEATURES'
  | 'LOGIN_PAGE_ENABLED';

export function portalConfigurationRefusal(
  config: ProviderPortalConfiguration,
  expected: { configurationId: string; accountId: string },
): PortalConfigurationRefusal | null {
  if (config.configurationId !== expected.configurationId) {
    return 'NOT_CONFIGURED';
  }
  if (config.accountId !== expected.accountId) return 'WRONG_ACCOUNT';
  if (config.livemode) return 'LIVE_MODE';
  if (!config.active) return 'INACTIVE';
  if (!config.paymentMethodUpdate) return 'NO_PAYMENT_METHOD_UPDATE';
  if (config.subscriptionCancel || config.subscriptionUpdate) {
    return 'ALLOWS_SUBSCRIPTION_CHANGES';
  }
  if (config.customerUpdate) return 'ALLOWS_CUSTOMER_UPDATES';
  if (config.otherEnabledFeatures.length > 0) return 'ALLOWS_OTHER_FEATURES';
  if (config.loginPage) return 'LOGIN_PAGE_ENABLED';
  return null;
}
