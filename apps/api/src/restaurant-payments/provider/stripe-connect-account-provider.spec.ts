import Stripe from 'stripe';
import {
  ConnectEventVerificationError,
  ConnectProviderError,
} from './connect-account-provider';
import {
  STRIPE_CONNECT_API_VERSION,
  StripeConnectAccountProvider,
} from './stripe-connect-account-provider';

// ESP-04 M1 — the Stripe Connect provider, offline: the SDK's account calls
// are replaced by recorders (no network, no Stripe account), and webhook
// signatures are produced and checked with the SDK's own helpers. Covers what
// is asked of Stripe (Accounts v2: the restaurant's full dashboard, Stripe
// collecting fees from the restaurant and covering losses, card payments,
// idempotency), what is read back, test-mode enforcement, and verification
// of classic and v2 (thin) events.

const SECRET = 'whsec_connectsecret1234567890ab';

function setup() {
  const stripe = new Stripe('sk_test_offline1234567890', {
    apiVersion: STRIPE_CONNECT_API_VERSION,
  });
  const create = jest.fn();
  const retrieve = jest.fn();
  const linkCreate = jest.fn();
  (stripe.v2.core.accounts as unknown as Record<string, unknown>).create =
    create;
  (stripe.v2.core.accounts as unknown as Record<string, unknown>).retrieve =
    retrieve;
  (stripe.v2.core.accountLinks as unknown as Record<string, unknown>).create =
    linkCreate;
  const provider = new StripeConnectAccountProvider(stripe, {
    webhookSecret: SECRET,
  });
  return { stripe, provider, create, retrieve, linkCreate };
}

const v2Account = (over: Record<string, unknown> = {}) => ({
  id: 'acct_1Test',
  object: 'v2.core.account',
  livemode: false,
  closed: false,
  dashboard: 'full',
  defaults: {
    responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' },
  },
  configuration: {
    merchant: {
      capabilities: {
        card_payments: { status: 'pending', status_details: [] },
      },
    },
  },
  requirements: {
    entries: [
      { awaiting_action_from: 'user', description: 'a' },
      { awaiting_action_from: 'user', description: 'b' },
      { awaiting_action_from: 'stripe', description: 'c' },
    ],
    summary: { minimum_deadline: { status: 'currently_due' } },
  },
  ...over,
});

describe('ESP-04 M1 Stripe Connect provider (offline)', () => {
  it("creates the restaurant's own account: full dashboard, Stripe-collected fees, Stripe-covered losses, card payments, idempotently", async () => {
    const { provider, create } = setup();
    create.mockResolvedValue(v2Account());
    await expect(
      provider.createAccount({
        idempotencyKey: 'centerivo-connect-account-row1',
        tenantId: 'tenant-1',
        displayName: 'Mocha House',
        contactEmail: 'owner@example.com',
        country: 'US',
      }),
    ).resolves.toEqual({ accountId: 'acct_1Test' });
    expect(create).toHaveBeenCalledWith(
      {
        display_name: 'Mocha House',
        contact_email: 'owner@example.com',
        identity: { country: 'US' },
        dashboard: 'full',
        defaults: {
          responsibilities: {
            fees_collector: 'stripe',
            losses_collector: 'stripe',
          },
        },
        configuration: {
          merchant: { capabilities: { card_payments: { requested: true } } },
        },
        metadata: { centerivo_tenant_id: 'tenant-1' },
      },
      { idempotencyKey: 'centerivo-connect-account-row1' },
    );
  });

  it('opens hosted onboarding for the merchant configuration, with our return pages', async () => {
    const { provider, linkCreate } = setup();
    linkCreate.mockResolvedValue({
      url: 'https://connect.stripe.com/setup/abc',
      livemode: false,
    });
    await expect(
      provider.createOnboardingLink({
        accountId: 'acct_1Test',
        refreshUrl: 'https://admin.example.com/admin/payments?connect=refresh',
        returnUrl: 'https://admin.example.com/admin/payments?connect=return',
      }),
    ).resolves.toEqual({ url: 'https://connect.stripe.com/setup/abc' });
    expect(linkCreate).toHaveBeenCalledWith({
      account: 'acct_1Test',
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['merchant'],
          refresh_url:
            'https://admin.example.com/admin/payments?connect=refresh',
          return_url: 'https://admin.example.com/admin/payments?connect=return',
        },
      },
    });
  });

  it('reads back exactly what Stripe reports about the account', async () => {
    const { provider, retrieve } = setup();
    retrieve.mockResolvedValue(v2Account());
    await expect(provider.retrieveAccount('acct_1Test')).resolves.toEqual({
      accountId: 'acct_1Test',
      livemode: false,
      closed: false,
      dashboard: 'full',
      feesCollector: 'stripe',
      lossesCollector: 'stripe',
      cardPaymentsStatus: 'pending',
      requirementsStatus: 'currently_due',
      requirementsDue: 2,
    });
    expect(retrieve).toHaveBeenCalledWith('acct_1Test', {
      include: ['configuration.merchant', 'defaults', 'requirements'],
    });
  });

  it('refuses live-mode objects, mismatched accounts, malformed ids and provider errors', async () => {
    const { provider, create, retrieve, linkCreate } = setup();
    create.mockResolvedValue(v2Account({ livemode: true }));
    await expect(
      provider.createAccount({
        idempotencyKey: 'k',
        tenantId: 't',
        displayName: 'x',
        contactEmail: null,
        country: 'US',
      }),
    ).rejects.toEqual(new ConnectProviderError('live_mode_refused'));
    retrieve.mockResolvedValue(v2Account({ livemode: true }));
    await expect(provider.retrieveAccount('acct_1Test')).rejects.toBeInstanceOf(
      ConnectProviderError,
    );
    retrieve.mockResolvedValue(v2Account({ id: 'acct_other' }));
    await expect(provider.retrieveAccount('acct_1Test')).rejects.toEqual(
      new ConnectProviderError('account_mismatch'),
    );
    await expect(provider.retrieveAccount('not-an-account')).rejects.toEqual(
      new ConnectProviderError('account_id_invalid'),
    );
    linkCreate.mockRejectedValue(new Error('network'));
    await expect(
      provider.createOnboardingLink({
        accountId: 'acct_1Test',
        refreshUrl: 'https://a',
        returnUrl: 'https://b',
      }),
    ).rejects.toEqual(new ConnectProviderError('account_link_failed'));
  });

  it('verifies classic and v2 (thin) events by signature over the raw body', () => {
    const { stripe, provider } = setup();
    const signed = (body: object, secret = SECRET) => {
      const payload = JSON.stringify(body);
      return {
        rawBody: Buffer.from(payload),
        signatureHeader: stripe.webhooks.generateTestHeaderString({
          payload,
          secret,
        }),
      };
    };
    const classic = provider.verifyEvent(
      signed({
        id: 'evt_1',
        object: 'event',
        type: 'account.updated',
        livemode: false,
        account: 'acct_1Test',
        data: { object: { id: 'acct_1Test', object: 'account' } },
      }),
    );
    expect(classic).toMatchObject({
      provider: 'stripe',
      externalEventId: 'evt_1',
      type: 'account.updated',
      livemode: false,
      externalAccountId: 'acct_1Test',
    });
    expect(classic.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    const thin = provider.verifyEvent(
      signed({
        id: 'evt_2',
        object: 'v2.core.event',
        type: 'v2.core.account.updated',
        livemode: false,
        related_object: { id: 'acct_1Test', type: 'v2.core.account' },
      }),
    );
    expect(thin.externalAccountId).toBe('acct_1Test');

    // Wrong secret, tampered body, no header.
    const forged = signed(
      {
        id: 'evt_3',
        object: 'event',
        type: 'account.updated',
        livemode: false,
      },
      'whsec_someoneelse1234567890abcd',
    );
    expect(() => provider.verifyEvent(forged)).toThrow(
      ConnectEventVerificationError,
    );
    const good = signed({
      id: 'evt_4',
      object: 'event',
      type: 'account.updated',
      livemode: false,
    });
    expect(() =>
      provider.verifyEvent({
        rawBody: Buffer.from(good.rawBody.toString().replace('evt_4', 'evt_5')),
        signatureHeader: good.signatureHeader,
      }),
    ).toThrow(ConnectEventVerificationError);
    expect(() =>
      provider.verifyEvent({
        rawBody: good.rawBody,
        signatureHeader: undefined,
      }),
    ).toThrow(ConnectEventVerificationError);
  });
});
