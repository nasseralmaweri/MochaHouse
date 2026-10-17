import Stripe from 'stripe';
import {
  STRIPE_API_VERSION,
  SUPPORTED_CHECKOUT_PAYMENT_METHOD_TYPES,
  StripeSaasBillingProvider,
} from './stripe-saas-billing-provider';
import {
  BillingEventVerificationError,
  SaasBillingProviderError,
} from './saas-billing-provider';
import {
  resolveSaasBillingProviderMode,
  SaasBillingConfigurationError,
} from './saas-billing-provider-mode';

// SC3b — the Stripe adapter against the REAL Stripe SDK with a mocked HTTP
// layer (no network, no Stripe account): signatures over the raw body,
// test-mode only, deterministic products/prices, Checkout parameters for
// cardless trials, and the request shapes and idempotency keys we send.
const WEBHOOK_SECRET = 'whsec_0123456789abcdefghijklmnopqrstuv';

interface Sent {
  method: string;
  path: string;
  body: URLSearchParams;
  idempotencyKey: string | null;
  apiVersion: string | null;
}

function harness(routes: Record<string, (sent: Sent) => [number, unknown]>) {
  const sent: Sent[] = [];
  const fetchFn = (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const request: Sent = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: new URLSearchParams(
        typeof init?.body === 'string' ? init.body : url.search,
      ),
      idempotencyKey: headers.get('idempotency-key'),
      apiVersion: headers.get('stripe-version'),
    };
    sent.push(request);
    const route = routes[`${request.method} ${request.path}`];
    const [status, body] = route
      ? route(request)
      : [
          404,
          {
            error: { type: 'invalid_request_error', code: 'resource_missing' },
          },
        ];
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'content-type': 'application/json',
          'request-id': 'req_test',
        },
      }),
    );
  };
  const stripe = new Stripe('sk_test_harness000000000000', {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(fetchFn),
    maxNetworkRetries: 0,
  });
  return {
    sent,
    stripe,
    provider: new StripeSaasBillingProvider(stripe, {
      webhookSecret: WEBHOOK_SECRET,
      portalConfigurationId: 'bpc_test0000000001',
      expectedAccountId: 'acct_test000000001',
    }),
  };
}

function signed(stripe: Stripe, event: object, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  return {
    rawBody: Buffer.from(payload),
    signatureHeader: stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
    }),
  };
}

const event = (type: string, object: object, over: object = {}) => ({
  id: 'evt_test_1',
  object: 'event',
  type,
  created: Math.floor(Date.now() / 1000) - 5,
  livemode: false,
  pending_webhooks: 1,
  api_version: STRIPE_API_VERSION,
  data: { object },
  ...over,
});

// SC3d-3 — a schedule phase as Stripe returns it (defaults: our one item at
// price_m99, nothing else set).
const phase = (over: object = {}) => ({
  start_date: 1_799_000_000,
  end_date: 1_802_000_000,
  items: [
    {
      price: 'price_m99',
      quantity: 1,
      discounts: [],
      tax_rates: [],
      metadata: {},
    },
  ],
  currency: 'usd',
  trial_end: null,
  add_invoice_items: [],
  application_fee_percent: null,
  billing_thresholds: null,
  on_behalf_of: null,
  transfer_data: null,
  automatic_tax: { enabled: false, liability: null },
  collection_method: null,
  default_payment_method: null,
  default_tax_rates: [],
  description: null,
  discounts: [],
  invoice_settings: null,
  metadata: {},
  ...over,
});

describe('SC3b Stripe adapter (mocked HTTP)', () => {
  describe('webhook verification', () => {
    it('verifies the signature over the ORIGINAL raw body and normalizes a Checkout completion', () => {
      const { stripe, provider } = harness({});
      const delivery = signed(
        stripe,
        event('checkout.session.completed', {
          id: 'cs_test_1',
          object: 'checkout.session',
          mode: 'subscription',
          customer: 'cus_1',
          subscription: 'sub_1',
          metadata: { centerivo_tenant_id: 'tenant-1' },
        }),
      );
      const verified = provider.verifyEvent(delivery);
      expect(verified).toMatchObject({
        provider: 'stripe',
        externalEventId: 'evt_test_1',
        livemode: false,
        externalSubscriptionId: 'sub_1',
        externalCustomerId: 'cus_1',
        claimedTenantId: 'tenant-1',
        event: { kind: 'CHECKOUT_COMPLETED', externalSessionId: 'cs_test_1' },
      });
    });

    it('refuses a tampered body, a re-serialized body, another secret and a missing signature', () => {
      const { stripe, provider } = harness({});
      const original = event('invoice.paid', {
        id: 'in_1',
        object: 'invoice',
        amount_paid: 4900,
        currency: 'usd',
      });
      const delivery = signed(stripe, original);
      const tampered = Buffer.from(
        delivery.rawBody.toString().replace('4900', '1'),
      );
      expect(() =>
        provider.verifyEvent({ ...delivery, rawBody: tampered }),
      ).toThrow(BillingEventVerificationError);
      const reserialized = Buffer.from(
        JSON.stringify(JSON.parse(delivery.rawBody.toString()), null, 2),
      );
      expect(() =>
        provider.verifyEvent({ ...delivery, rawBody: reserialized }),
      ).toThrow(BillingEventVerificationError);
      const other = signed(
        stripe,
        original,
        'whsec_another0000000000000000000000',
      );
      expect(() => provider.verifyEvent(other)).toThrow(
        BillingEventVerificationError,
      );
      expect(() =>
        provider.verifyEvent({ ...delivery, signatureHeader: undefined }),
      ).toThrow(BillingEventVerificationError);
    });

    it('carries livemode through (the lifecycle rejects live events) and digests only stable content', () => {
      const { stripe, provider } = harness({});
      const base = event('customer.subscription.updated', {
        id: 'sub_1',
        object: 'subscription',
        customer: 'cus_1',
      });
      const first = provider.verifyEvent(signed(stripe, base));
      const redelivered = provider.verifyEvent(
        signed(stripe, { ...base, pending_webhooks: 3 }),
      );
      expect(redelivered.payloadDigest).toBe(first.payloadDigest);
      expect(first.event).toEqual({ kind: 'SUBSCRIPTION_CHANGED' });
      const live = provider.verifyEvent(
        signed(stripe, { ...base, livemode: true }),
      );
      expect(live.livemode).toBe(true);
    });

    it('normalizes a paid invoice (amount, currency, period, subscription) and ignores other types', () => {
      const { stripe, provider } = harness({});
      const paid = provider.verifyEvent(
        signed(
          stripe,
          event('invoice.paid', {
            id: 'in_1',
            object: 'invoice',
            amount_paid: 4900,
            currency: 'usd',
            customer: 'cus_1',
            parent: { subscription_details: { subscription: 'sub_1' } },
            lines: {
              data: [{ period: { start: 1_800_000_000, end: 1_802_592_000 } }],
            },
          }),
        ),
      );
      expect(paid.externalSubscriptionId).toBe('sub_1');
      expect(paid.event).toEqual({
        kind: 'PAYMENT_SUCCEEDED',
        reference: 'in_1',
        amountMinorUnits: 4900,
        currency: 'USD',
        periodStart: new Date(1_800_000_000_000),
        periodEnd: new Date(1_802_592_000_000),
      });
      const other = provider.verifyEvent(
        signed(stripe, event('customer.updated', { id: 'cus_1' })),
      );
      expect(other.event).toEqual({ kind: 'UNSUPPORTED' });
    });
  });

  describe('Checkout', () => {
    const session = (over: object = {}) => ({
      id: 'cs_test_1',
      object: 'checkout.session',
      status: 'open',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
      expires_at: 1_800_000_000,
      customer: 'cus_1',
      subscription: null,
      livemode: false,
      ...over,
    });

    it('a cardless trial: payment method only if required, and Stripe ENDS the subscription without one', async () => {
      const { sent, provider } = harness({
        'POST /v1/checkout/sessions': () => [200, session()],
      });
      const result = await provider.createCheckoutSession({
        idempotencyKey: 'centerivo-checkout-abc',
        checkoutSessionId: 'abc',
        tenantId: 'tenant-1',
        externalCustomerId: 'cus_1',
        externalPriceId: 'price_1',
        trialDays: 14,
        requiresPaymentMethod: false,
        successUrl: 'https://admin.example.test/admin/billing?checkout=success',
        cancelUrl:
          'https://admin.example.test/admin/billing?checkout=cancelled',
      });
      expect(result).toMatchObject({
        status: 'open',
        url: 'https://checkout.stripe.com/c/pay/cs_test_1',
      });
      const request = sent[0];
      expect(request.idempotencyKey).toBe('centerivo-checkout-abc');
      expect(request.apiVersion).toBe(STRIPE_API_VERSION);
      expect(request.body.get('mode')).toBe('subscription');
      expect(request.body.get('customer')).toBe('cus_1');
      expect(request.body.get('line_items[0][price]')).toBe('price_1');
      expect(request.body.get('payment_method_collection')).toBe('if_required');
      expect(request.body.get('subscription_data[trial_period_days]')).toBe(
        '14',
      );
      expect(
        request.body.get(
          'subscription_data[trial_settings][end_behavior][missing_payment_method]',
        ),
      ).toBe('cancel');
      expect(request.body.get('client_reference_id')).toBe('abc');
    });

    it('a card is always collected when the trial requires one, or there is no trial', async () => {
      for (const [trialDays, requiresPaymentMethod] of [
        [14, true],
        [0, false],
      ] as const) {
        const { sent, provider } = harness({
          'POST /v1/checkout/sessions': () => [200, session()],
        });
        await provider.createCheckoutSession({
          idempotencyKey: 'k',
          checkoutSessionId: 'abc',
          tenantId: 't',
          externalCustomerId: 'cus_1',
          externalPriceId: 'price_1',
          trialDays,
          requiresPaymentMethod,
          successUrl: 'https://a.test/s',
          cancelUrl: 'https://a.test/c',
        });
        expect(sent[0].body.get('payment_method_collection')).toBe('always');
        // SC3c-2 — card only (synchronous confirmation), every time.
        expect(sent[0].body.getAll('payment_method_types[0]')).toEqual([
          'card',
        ]);
        expect(sent[0].body.get('payment_method_types[1]')).toBeNull();
        if (trialDays === 0) {
          expect(
            sent[0].body.get('subscription_data[trial_period_days]'),
          ).toBeNull();
        }
      }
    });

    it('refuses any live-mode object read back', async () => {
      const { provider } = harness({
        'GET /v1/checkout/sessions/cs_test_1': () => [
          200,
          session({ livemode: true }),
        ],
      });
      await expect(
        provider.retrieveCheckoutSession('cs_test_1'),
      ).rejects.toBeInstanceOf(SaasBillingProviderError);
    });
  });

  describe('deterministic product and price sync', () => {
    const product = (over: object = {}) => ({
      id: 'centerivo_plan_p1',
      object: 'product',
      livemode: false,
      metadata: { centerivo_plan_id: 'p1' },
      ...over,
    });
    const price = (over: object = {}) => ({
      id: 'price_1',
      object: 'price',
      livemode: false,
      unit_amount: 4900,
      currency: 'usd',
      recurring: { interval: 'month', interval_count: 1 },
      product: 'centerivo_plan_p1',
      metadata: { centerivo_price_id: 'pr1' },
      ...over,
    });

    it('creates the product with OUR id; "already exists" reads and checks the existing one', async () => {
      const created = harness({ 'POST /v1/products': () => [200, product()] });
      await expect(
        created.provider.ensureProduct({ planId: 'p1', planName: 'Growth' }),
      ).resolves.toEqual({
        externalProductId: 'centerivo_plan_p1',
      });
      expect(created.sent[0].body.get('id')).toBe('centerivo_plan_p1');
      expect(created.sent[0].idempotencyKey).toBe('centerivo-product-p1');

      const exists = harness({
        'POST /v1/products': () => [
          400,
          {
            error: {
              type: 'invalid_request_error',
              code: 'resource_already_exists',
            },
          },
        ],
        'GET /v1/products/centerivo_plan_p1': () => [200, product()],
      });
      await expect(
        exists.provider.ensureProduct({ planId: 'p1', planName: 'Growth' }),
      ).resolves.toEqual({
        externalProductId: 'centerivo_plan_p1',
      });

      const foreign = harness({
        'POST /v1/products': () => [
          400,
          {
            error: {
              type: 'invalid_request_error',
              code: 'resource_already_exists',
            },
          },
        ],
        'GET /v1/products/centerivo_plan_p1': () => [
          200,
          product({ metadata: { centerivo_plan_id: 'other' } }),
        ],
      });
      await expect(
        foreign.provider.ensureProduct({ planId: 'p1', planName: 'Growth' }),
      ).rejects.toBeInstanceOf(SaasBillingProviderError);
    });

    const input = {
      priceId: 'pr1',
      externalProductId: 'centerivo_plan_p1',
      amountMinorUnits: 4900,
      currency: 'USD',
      interval: 'MONTH' as const,
    };

    it('reuses a price found by its lookup key only when it matches our amount, currency, interval and product', async () => {
      const found = harness({
        'GET /v1/prices': () => [
          200,
          { object: 'list', data: [price()], has_more: false },
        ],
      });
      await expect(found.provider.ensurePrice(input)).resolves.toEqual({
        externalPriceId: 'price_1',
      });
      expect(found.sent.map((s) => s.method)).toEqual(['GET']);

      const mismatched = harness({
        'GET /v1/prices': () => [
          200,
          {
            object: 'list',
            data: [price({ unit_amount: 100 })],
            has_more: false,
          },
        ],
      });
      await expect(
        mismatched.provider.ensurePrice(input),
      ).rejects.toBeInstanceOf(SaasBillingProviderError);
    });

    it('otherwise creates it with the lookup key and a deterministic idempotency key', async () => {
      const { sent, provider } = harness({
        'GET /v1/prices': () => [
          200,
          { object: 'list', data: [], has_more: false },
        ],
        'POST /v1/prices': () => [200, price()],
      });
      await expect(provider.ensurePrice(input)).resolves.toEqual({
        externalPriceId: 'price_1',
      });
      const create = sent.find((s) => s.method === 'POST')!;
      expect(create.idempotencyKey).toBe('centerivo-price-pr1');
      expect(create.body.get('lookup_key')).toBe('centerivo_price_pr1');
      expect(create.body.get('unit_amount')).toBe('4900');
      expect(create.body.get('recurring[interval]')).toBe('month');
    });
  });

  it('reads a subscription snapshot and an unknown invoice as null', async () => {
    const { provider } = harness({
      'GET /v1/subscriptions/sub_1': () => [
        200,
        {
          id: 'sub_1',
          object: 'subscription',
          customer: 'cus_1',
          status: 'trialing',
          livemode: false,
          default_payment_method: null,
          default_source: null,
          cancel_at_period_end: false,
          trial_start: 1_800_000_000,
          trial_end: 1_801_209_600,
        },
      ],
    });
    await expect(provider.retrieveSubscription('sub_1')).resolves.toMatchObject(
      {
        status: 'trialing',
        hasPaymentMethod: false,
        trialEnd: new Date(1_801_209_600_000),
      },
    );
    await expect(provider.retrieveInvoice('in_missing')).resolves.toBeNull();
  });

  describe('SC3c-2 recovery reads', () => {
    const invoice = (over: Record<string, unknown>) => ({
      id: 'in_1',
      object: 'invoice',
      status: 'open',
      livemode: false,
      customer: 'cus_1',
      amount_paid: 0,
      amount_due: 4900,
      currency: 'usd',
      created: 1_800_000_000,
      hosted_invoice_url: 'https://invoice.stripe.com/i/acct_1/test_1',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'sub_1' },
      },
      ...over,
    });

    it("lists only THIS subscription's open invoices, oldest first, with their hosted pages", async () => {
      const { provider, sent } = harness({
        'GET /v1/invoices': () => [
          200,
          {
            object: 'list',
            has_more: false,
            data: [
              invoice({ id: 'in_new', created: 1_800_000_100 }),
              invoice({ id: 'in_old', created: 1_800_000_000 }),
              invoice({
                id: 'in_other',
                parent: {
                  type: 'subscription_details',
                  subscription_details: { subscription: 'sub_other' },
                },
              }),
              // A shape we cannot read: still outstanding, never dropped.
              invoice({
                id: 'in_unknown',
                created: 1_800_000_050,
                parent: null,
              }),
            ],
          },
        ],
      });
      const open = await provider.listOpenInvoices('sub_1');
      expect(open.map((i) => i.externalInvoiceId)).toEqual([
        'in_old',
        'in_unknown',
        'in_new',
      ]);
      expect(open[1].externalSubscriptionId).toBeNull();
      expect(open[0]).toMatchObject({
        status: 'open',
        amountDueMinorUnits: 4900,
        hostedInvoiceUrl: 'https://invoice.stripe.com/i/acct_1/test_1',
      });
      expect(sent[0].body.get('subscription')).toBe('sub_1');
      expect(sent[0].body.get('status')).toBe('open');
    });

    it('a live-mode invoice is refused', async () => {
      const { provider } = harness({
        'GET /v1/invoices': () => [
          200,
          {
            object: 'list',
            has_more: false,
            data: [invoice({ livemode: true })],
          },
        ],
      });
      await expect(provider.listOpenInvoices('sub_1')).rejects.toBeInstanceOf(
        SaasBillingProviderError,
      );
    });

    it('reads the portal configuration and the account it belongs to; creates a session for one customer', async () => {
      const { provider, sent } = harness({
        'GET /v1/billing_portal/configurations/bpc_test0000000001': () => [
          200,
          {
            id: 'bpc_test0000000001',
            object: 'billing_portal.configuration',
            active: true,
            livemode: false,
            is_default: false,
            login_page: { enabled: false, url: null },
            features: {
              customer_update: { enabled: false, allowed_updates: [] },
              invoice_history: { enabled: true },
              payment_method_update: { enabled: true },
              subscription_cancel: { enabled: false },
              subscription_update: { enabled: false },
              subscription_pause: { enabled: true },
            },
          },
        ],
        'GET /v1/account': () => [
          200,
          { id: 'acct_test000000001', object: 'account' },
        ],
        'POST /v1/billing_portal/sessions': () => [
          200,
          {
            id: 'bps_1',
            object: 'billing_portal.session',
            livemode: false,
            url: 'https://billing.stripe.com/p/session/test_1',
          },
        ],
      });
      expect(provider.portalConfigurationId).toBe('bpc_test0000000001');
      await expect(
        provider.retrievePortalConfiguration('bpc_test0000000001'),
      ).resolves.toEqual({
        configurationId: 'bpc_test0000000001',
        accountId: 'acct_test000000001',
        livemode: false,
        active: true,
        paymentMethodUpdate: true,
        invoiceHistory: true,
        subscriptionCancel: false,
        subscriptionUpdate: false,
        customerUpdate: false,
        loginPage: false,
        // Reported (and refused by the check), never ignored.
        otherEnabledFeatures: ['subscription_pause'],
      });
      await expect(
        provider.createPortalSession({
          externalCustomerId: 'cus_1',
          configurationId: 'bpc_test0000000001',
          returnUrl: 'https://admin.example.test/admin/billing?portal=returned',
        }),
      ).resolves.toEqual({
        url: 'https://billing.stripe.com/p/session/test_1',
        livemode: false,
      });
      const created = sent.find(
        (r) => r.path === '/v1/billing_portal/sessions',
      )!;
      expect(created.body.get('customer')).toBe('cus_1');
      expect(created.body.get('configuration')).toBe('bpc_test0000000001');
    });
  });

  describe('payment method the provider will charge (Checkout and customer defaults)', () => {
    const subscription = (over: Record<string, unknown>) => ({
      id: 'sub_pm',
      object: 'subscription',
      customer: {
        id: 'cus_1',
        object: 'customer',
        livemode: false,
        default_source: null,
        invoice_settings: { default_payment_method: null },
      },
      status: 'active',
      livemode: false,
      collection_method: 'charge_automatically',
      default_payment_method: null,
      default_source: null,
      cancel_at_period_end: false,
      trial_start: null,
      trial_end: null,
      ...over,
    });
    const read = async (body: Record<string, unknown>) => {
      const { provider, sent } = harness({
        'GET /v1/subscriptions/sub_pm': () => [200, body],
      });
      const snapshot = await provider.retrieveSubscription('sub_pm');
      return { snapshot, sent };
    };

    it("Checkout's method on the subscription counts, and the customer is expanded", async () => {
      const { snapshot, sent } = await read(
        subscription({ default_payment_method: 'pm_checkout' }),
      );
      expect(snapshot).toMatchObject({
        externalCustomerId: 'cus_1',
        hasPaymentMethod: true,
        paymentMethodSource: 'SUBSCRIPTION',
      });
      expect([...sent[0].body.values()]).toContain('customer');
    });

    it("the customer's default method (or legacy default source) counts too", async () => {
      for (const customer of [
        {
          id: 'cus_1',
          object: 'customer',
          livemode: false,
          default_source: null,
          invoice_settings: { default_payment_method: 'pm_customer' },
        },
        {
          id: 'cus_1',
          object: 'customer',
          livemode: false,
          default_source: 'card_legacy',
          invoice_settings: { default_payment_method: null },
        },
      ]) {
        const { snapshot } = await read(subscription({ customer }));
        expect(snapshot).toMatchObject({
          hasPaymentMethod: true,
          paymentMethodSource: 'CUSTOMER_DEFAULT',
        });
      }
    });

    it('none: no default anywhere, a deleted customer, or an invoice-only subscription', async () => {
      for (const over of [
        {},
        { customer: { id: 'cus_1', object: 'customer', deleted: true } },
        {
          collection_method: 'send_invoice',
          default_payment_method: 'pm_checkout',
        },
      ]) {
        const { snapshot } = await read(subscription(over));
        expect(snapshot).toMatchObject({
          hasPaymentMethod: false,
          paymentMethodSource: null,
        });
      }
    });

    it('a live-mode customer is refused', async () => {
      await expect(
        read(
          subscription({
            customer: {
              id: 'cus_1',
              object: 'customer',
              livemode: true,
              invoice_settings: { default_payment_method: null },
            },
          }),
        ),
      ).rejects.toBeInstanceOf(SaasBillingProviderError);
    });
  });

  // SC3c-2 — asynchronous payment methods (bank debits, transfers,
  // vouchers…) confirm days later and need their own confirmation and
  // recovery lifecycle. Adding one here must be a deliberate, reviewed
  // change: this pins the list.
  it('Checkout offers only synchronously-confirmed payment methods (card)', () => {
    expect([...SUPPORTED_CHECKOUT_PAYMENT_METHOD_TYPES]).toEqual(['card']);
  });

  it('configuration: test keys only, never live keys, never in production', () => {
    const env = {
      SAAS_BILLING_PROVIDER: 'stripe',
      STRIPE_BILLING_SECRET_KEY: 'sk_test_1234567890abcdef',
      STRIPE_BILLING_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NODE_ENV: 'test',
    };
    expect(resolveSaasBillingProviderMode(env)).toBe('stripe');
    for (const bad of [
      { ...env, STRIPE_BILLING_SECRET_KEY: 'sk_live_1234567890abcdef' },
      { ...env, STRIPE_BILLING_SECRET_KEY: 'rk_live_1234567890abcdef' },
      {
        SAAS_BILLING_PROVIDER: 'disabled',
        STRIPE_BILLING_SECRET_KEY: 'sk_live_1234567890abcdef',
      },
      { ...env, STRIPE_BILLING_SECRET_KEY: 'pk_test_1234567890abcdef' },
      { ...env, STRIPE_BILLING_WEBHOOK_SECRET: 'not-a-secret' },
      { ...env, NODE_ENV: 'production' },
    ]) {
      expect(() => resolveSaasBillingProviderMode(bad)).toThrow(
        SaasBillingConfigurationError,
      );
    }
  });
});

// SC3d-1 — plan change foundations against the real SDK (mocked HTTP): the
// billed price is read, previews create nothing, an immediate change is ONLY
// ever "apply if paid" at the previewed proration date, a period-end change
// is a schedule that releases the subscription, and a schedule is RELEASED —
// never cancelled (that would end the subscription).
describe('SC3d-1 Stripe plan change foundations (mocked HTTP)', () => {
  const PRORATION = new Date(1_800_000_000_000);
  const subscription = (over: Record<string, unknown> = {}) => ({
    id: 'sub_1',
    object: 'subscription',
    customer: 'cus_1',
    status: 'active',
    livemode: false,
    default_payment_method: 'pm_1',
    default_source: null,
    cancel_at_period_end: false,
    trial_start: null,
    trial_end: null,
    latest_invoice: 'in_latest',
    schedule: null,
    pending_update: null,
    items: {
      object: 'list',
      has_more: false,
      data: [
        {
          id: 'si_1',
          object: 'subscription_item',
          price: { id: 'price_m49', object: 'price' },
          quantity: 1,
          current_period_end: 1_802_000_000,
        },
      ],
    },
    ...over,
  });
  const previewInvoice = (over: Record<string, unknown> = {}) => ({
    object: 'invoice',
    livemode: false,
    currency: 'usd',
    amount_due: 2750,
    total: 2750,
    total_taxes: [{ amount: 250 }],
    total_discount_amounts: [{ amount: 500 }],
    lines: {
      object: 'list',
      has_more: false,
      data: [
        {
          amount: -2000,
          parent: { subscription_item_details: { proration: true } },
        },
        {
          amount: 5000,
          parent: { subscription_item_details: { proration: true } },
        },
        { amount: 250, parent: null },
      ],
    },
    ...over,
  });

  it('reads what Stripe bills: items, schedule, pending update and period end', async () => {
    const { provider } = harness({
      'GET /v1/subscriptions/sub_1': () => [
        200,
        subscription({
          schedule: 'sub_sched_1',
          pending_update: { expires_at: 1_800_100_000, subscription_items: [] },
        }),
      ],
    });
    await expect(provider.retrieveSubscription('sub_1')).resolves.toMatchObject(
      {
        items: [
          { externalItemId: 'si_1', externalPriceId: 'price_m49', quantity: 1 },
        ],
        scheduleId: 'sub_sched_1',
        hasPendingUpdate: true,
        currentPeriodEnd: new Date(1_802_000_000_000),
      },
    );
  });

  it('a truncated item list is not trusted', async () => {
    const { provider } = harness({
      'GET /v1/subscriptions/sub_1': () => [
        200,
        subscription({ items: { object: 'list', has_more: true, data: [] } }),
      ],
    });
    await expect(provider.retrieveSubscription('sub_1')).resolves.toMatchObject(
      { items: [] },
    );
  });

  it("previews the charge with Stripe's own proration (tax, discounts, credits) at the given proration date", async () => {
    const { provider, sent } = harness({
      'POST /v1/invoices/create_preview': () => [200, previewInvoice()],
    });
    await expect(
      provider.previewImmediateChange({
        externalSubscriptionId: 'sub_1',
        externalItemId: 'si_1',
        toExternalPriceId: 'price_m99',
        prorationDate: PRORATION,
      }),
    ).resolves.toEqual({
      livemode: false,
      currency: 'usd',
      amountDueMinorUnits: 2750,
      totalMinorUnits: 2750,
      taxMinorUnits: 250,
      discountMinorUnits: 500,
      prorationMinorUnits: 3000,
    });
    const [request] = sent;
    expect(request.body.get('subscription')).toBe('sub_1');
    expect(request.body.get('subscription_details[items][0][id]')).toBe('si_1');
    expect(request.body.get('subscription_details[items][0][price]')).toBe(
      'price_m99',
    );
    expect(request.body.get('subscription_details[proration_behavior]')).toBe(
      'always_invoice',
    );
    expect(request.body.get('subscription_details[proration_date]')).toBe(
      '1800000000',
    );
  });

  it('a preview with truncated lines, a live preview or an unreadable amount is refused', async () => {
    for (const over of [
      { lines: { object: 'list', has_more: true, data: [] } },
      { livemode: true },
      { total: 'x' },
    ]) {
      const { provider } = harness({
        'POST /v1/invoices/create_preview': () => [200, previewInvoice(over)],
      });
      await expect(
        provider.previewImmediateChange({
          externalSubscriptionId: 'sub_1',
          externalItemId: 'si_1',
          toExternalPriceId: 'price_m99',
          prorationDate: PRORATION,
        }),
      ).rejects.toBeInstanceOf(SaasBillingProviderError);
    }
  });

  it('previews the recurring bill after the change', async () => {
    const { provider, sent } = harness({
      'POST /v1/invoices/create_preview': () => [
        200,
        previewInvoice({ total: 9900 }),
      ],
    });
    await expect(
      provider.previewRecurring({
        externalSubscriptionId: 'sub_1',
        externalItemId: 'si_1',
        toExternalPriceId: 'price_m99',
      }),
    ).resolves.toEqual({
      livemode: false,
      currency: 'usd',
      totalMinorUnits: 9900,
    });
    expect(sent[0].body.get('preview_mode')).toBe('recurring');
  });

  it('an immediate change is ALWAYS "apply only if paid", prorated and invoiced now, idempotent', async () => {
    const { provider, sent } = harness({
      'POST /v1/subscriptions/sub_1': () => [
        200,
        subscription({
          latest_invoice: 'in_change',
          pending_update: { expires_at: 1_800_100_000, subscription_items: [] },
        }),
      ],
    });
    await expect(
      provider.changePriceNow({
        idempotencyKey: 'centerivo-plan-change-c1-change-now',
        externalSubscriptionId: 'sub_1',
        externalItemId: 'si_1',
        toExternalPriceId: 'price_m99',
        prorationDate: PRORATION,
      }),
    ).resolves.toMatchObject({
      externalInvoiceId: 'in_change',
      pendingUpdate: true,
    });
    const [request] = sent;
    expect(request.body.get('payment_behavior')).toBe('pending_if_incomplete');
    expect(request.body.get('proration_behavior')).toBe('always_invoice');
    expect(request.body.get('proration_date')).toBe('1800000000');
    expect(request.body.get('items[0][id]')).toBe('si_1');
    expect(request.body.get('items[0][price]')).toBe('price_m99');
    expect(request.idempotencyKey).toBe('centerivo-plan-change-c1-change-now');
  });

  it('a period-end change is a schedule: current price to the period end, then the new one, then released', async () => {
    const { provider, sent } = harness({
      'POST /v1/subscription_schedules': () => [
        200,
        {
          id: 'sub_sched_1',
          object: 'subscription_schedule',
          livemode: false,
          phases: [
            phase({ start_date: 1_799_000_000, end_date: 1_802_000_000 }),
          ],
        },
      ],
      'POST /v1/subscription_schedules/sub_sched_1': () => [
        200,
        {
          id: 'sub_sched_1',
          object: 'subscription_schedule',
          livemode: false,
          phases: [],
        },
      ],
    });
    await expect(
      provider.schedulePriceChangeAtPeriodEnd({
        idempotencyKey: 'centerivo-plan-change-c2-schedule',
        externalSubscriptionId: 'sub_1',
        fromExternalPriceId: 'price_m99',
        toExternalPriceId: 'price_m49',
        toInterval: 'MONTH',
      }),
    ).resolves.toEqual({ externalScheduleId: 'sub_sched_1' });
    const [create, update] = sent;
    expect(create.body.get('from_subscription')).toBe('sub_1');
    expect(create.idempotencyKey).toBe(
      'centerivo-plan-change-c2-schedule-create',
    );
    expect(update.body.get('end_behavior')).toBe('release');
    expect(update.body.get('phases[0][items][0][price]')).toBe('price_m99');
    expect(update.body.get('phases[0][start_date]')).toBe('1799000000');
    expect(update.body.get('phases[0][end_date]')).toBe('1802000000');
    expect(update.body.get('phases[0][proration_behavior]')).toBe('none');
    expect(update.body.get('phases[0][currency]')).toBe('usd');
    expect(update.body.get('phases[0][trial_end]')).toBeNull();
    expect(update.body.get('phases[1][items][0][price]')).toBe('price_m49');
    expect(update.body.get('phases[1][duration][interval]')).toBe('month');
    expect(update.body.get('phases[1][proration_behavior]')).toBe('none');
    expect(update.idempotencyKey).toBe(
      'centerivo-plan-change-c2-schedule-phases',
    );
  });

  // SC3d-3 — Stripe UNSETS current-phase settings an update omits: a trial
  // must be passed back or it would end at once.
  it('a trial plan choice keeps the trial end, the payment method and the tax settings of the current phase', async () => {
    const { provider, sent } = harness({
      'POST /v1/subscription_schedules': () => [
        200,
        {
          id: 'sub_sched_t',
          object: 'subscription_schedule',
          livemode: false,
          phases: [
            phase({
              start_date: 1_799_000_000,
              end_date: 1_800_209_600,
              trial_end: 1_800_209_600,
              default_payment_method: 'pm_1',
              default_tax_rates: [{ id: 'txr_1', object: 'tax_rate' }],
              collection_method: 'charge_automatically',
              metadata: { centerivo_tenant_id: 'tenant-1' },
            }),
          ],
        },
      ],
      'POST /v1/subscription_schedules/sub_sched_t': () => [
        200,
        {
          id: 'sub_sched_t',
          object: 'subscription_schedule',
          livemode: false,
          phases: [],
        },
      ],
    });
    await provider.schedulePriceChangeAtPeriodEnd({
      idempotencyKey: 'centerivo-plan-change-t1-schedule',
      externalSubscriptionId: 'sub_1',
      fromExternalPriceId: 'price_m99',
      toExternalPriceId: 'price_y990',
      toInterval: 'YEAR',
    });
    const update = sent[1].body;
    expect(update.get('phases[0][trial_end]')).toBe('1800209600');
    expect(update.get('phases[0][end_date]')).toBe('1800209600');
    expect(update.get('phases[0][default_payment_method]')).toBe('pm_1');
    expect(update.get('phases[0][default_tax_rates][0]')).toBe('txr_1');
    expect(update.get('phases[0][collection_method]')).toBe(
      'charge_automatically',
    );
    expect(update.get('phases[0][metadata][centerivo_tenant_id]')).toBe(
      'tenant-1',
    );
    expect(update.get('phases[1][items][0][price]')).toBe('price_y990');
    expect(update.get('phases[1][duration][interval]')).toBe('year');
    // The next phase keeps the payment, tax and metadata settings.
    expect(update.get('phases[1][default_payment_method]')).toBe('pm_1');
    expect(update.get('phases[1][default_tax_rates][0]')).toBe('txr_1');
    expect(update.get('phases[1][collection_method]')).toBe(
      'charge_automatically',
    );
    expect(update.get('phases[1][metadata][centerivo_tenant_id]')).toBe(
      'tenant-1',
    );
    expect(update.get('phases[1][currency]')).toBeNull();
    // Nothing that would end the trial or bill now.
    expect(update.get('phases[1][trial_end]')).toBeNull();
    expect(update.get('phases[0][billing_cycle_anchor]')).toBeNull();
  });

  it('a current phase with settings we cannot reproduce: the new schedule is RELEASED and nothing is changed', async () => {
    const { provider, sent } = harness({
      'POST /v1/subscription_schedules': () => [
        200,
        {
          id: 'sub_sched_u',
          object: 'subscription_schedule',
          livemode: false,
          phases: [
            phase({
              start_date: 1_799_000_000,
              end_date: 1_802_000_000,
              add_invoice_items: [{ price: 'price_setup', quantity: 1 }],
            }),
          ],
        },
      ],
      'POST /v1/subscription_schedules/sub_sched_u/release': () => [
        200,
        {
          id: 'sub_sched_u',
          object: 'subscription_schedule',
          livemode: false,
          status: 'released',
          released_subscription: 'sub_1',
        },
      ],
    });
    await expect(
      provider.schedulePriceChangeAtPeriodEnd({
        idempotencyKey: 'centerivo-plan-change-u1-schedule',
        externalSubscriptionId: 'sub_1',
        fromExternalPriceId: 'price_m99',
        toExternalPriceId: 'price_m49',
        toInterval: 'MONTH',
      }),
    ).rejects.toThrow('schedule_phase_unsupported');
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /v1/subscription_schedules',
      'POST /v1/subscription_schedules/sub_sched_u/release',
    ]);
  });

  it('a different price in the current phase is never carried into the schedule', async () => {
    const { provider, sent } = harness({
      'POST /v1/subscription_schedules': () => [
        200,
        {
          id: 'sub_sched_p',
          object: 'subscription_schedule',
          livemode: false,
          phases: [
            phase({
              start_date: 1_799_000_000,
              end_date: 1_802_000_000,
              items: [{ price: 'price_other', quantity: 1 }],
            }),
          ],
        },
      ],
      'POST /v1/subscription_schedules/sub_sched_p/release': () => [
        200,
        {
          id: 'sub_sched_p',
          object: 'subscription_schedule',
          livemode: false,
          status: 'released',
          released_subscription: 'sub_1',
        },
      ],
    });
    await expect(
      provider.schedulePriceChangeAtPeriodEnd({
        idempotencyKey: 'centerivo-plan-change-p1-schedule',
        externalSubscriptionId: 'sub_1',
        fromExternalPriceId: 'price_m99',
        toExternalPriceId: 'price_m49',
        toInterval: 'MONTH',
      }),
    ).rejects.toThrow('schedule_phase_unsupported');
    expect(
      sent.some((r) => r.path === '/v1/subscription_schedules/sub_sched_p'),
    ).toBe(false);
  });

  it('reads a schedule (phases, trial end, status) and treats a missing one as none', async () => {
    const { provider } = harness({
      'GET /v1/subscription_schedules/sub_sched_1': () => [
        200,
        {
          id: 'sub_sched_1',
          object: 'subscription_schedule',
          livemode: false,
          status: 'active',
          subscription: 'sub_1',
          phases: [
            phase({
              start_date: 1_799_000_000,
              end_date: 1_802_000_000,
              trial_end: 1_802_000_000,
            }),
            phase({
              start_date: 1_802_000_000,
              end_date: 1_804_592_000,
              items: [{ price: 'price_m49', quantity: 1 }],
            }),
          ],
        },
      ],
    });
    await expect(provider.retrieveSchedule('sub_sched_1')).resolves.toEqual({
      externalScheduleId: 'sub_sched_1',
      livemode: false,
      status: 'active',
      externalSubscriptionId: 'sub_1',
      phases: [
        {
          externalPriceId: 'price_m99',
          quantity: 1,
          startDate: new Date(1_799_000_000_000),
          endDate: new Date(1_802_000_000_000),
          trialEnd: new Date(1_802_000_000_000),
        },
        {
          externalPriceId: 'price_m49',
          quantity: 1,
          startDate: new Date(1_802_000_000_000),
          endDate: new Date(1_804_592_000_000),
          trialEnd: null,
        },
      ],
    });
    await expect(
      provider.retrieveSchedule('sub_sched_gone'),
    ).resolves.toBeNull();
  });

  it('schedule events re-read the subscription they manage (or released)', () => {
    const { stripe, provider } = harness({});
    for (const type of [
      'subscription_schedule.updated',
      'subscription_schedule.canceled',
      'subscription_schedule.completed',
      'subscription_schedule.aborted',
      'subscription_schedule.expiring',
    ]) {
      const verified = provider.verifyEvent(
        signed(
          stripe,
          event(type, {
            id: 'sub_sched_1',
            object: 'subscription_schedule',
            customer: 'cus_1',
            subscription: 'sub_1',
          }),
        ),
      );
      expect(verified).toMatchObject({
        event: { kind: 'SUBSCRIPTION_CHANGED' },
        externalSubscriptionId: 'sub_1',
      });
    }
    const released = provider.verifyEvent(
      signed(
        stripe,
        event('subscription_schedule.released', {
          id: 'sub_sched_1',
          object: 'subscription_schedule',
          customer: 'cus_1',
          subscription: null,
          released_subscription: 'sub_1',
        }),
      ),
    );
    expect(released).toMatchObject({
      event: { kind: 'SUBSCRIPTION_CHANGED' },
      externalSubscriptionId: 'sub_1',
    });
  });

  it('removing a scheduled change RELEASES the schedule and never cancels it (or the subscription)', async () => {
    const { provider, sent } = harness({
      'POST /v1/subscription_schedules/sub_sched_1/release': () => [
        200,
        {
          id: 'sub_sched_1',
          object: 'subscription_schedule',
          livemode: false,
          status: 'released',
          released_subscription: 'sub_1',
        },
      ],
    });
    await expect(
      provider.releaseSchedule({
        idempotencyKey: 'centerivo-plan-change-c2-release',
        externalScheduleId: 'sub_sched_1',
      }),
    ).resolves.toEqual({ releasedSubscriptionId: 'sub_1' });
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /v1/subscription_schedules/sub_sched_1/release',
    ]);
    expect(sent[0].body.get('preserve_cancel_date')).toBe('true');
    expect(
      sent.some((r) => r.path.endsWith('/cancel') || r.method === 'DELETE'),
    ).toBe(false);
  });
});

// SC3d-2 — what settlement relies on: an invoice's billing reason and
// currency, the period start, and the pending-update events.
describe('SC3d-2 Stripe reads for plan changes (mocked HTTP)', () => {
  it('reads an invoice billing reason and currency, and the period start', async () => {
    const { provider } = harness({
      'GET /v1/invoices/in_up': () => [
        200,
        {
          id: 'in_up',
          object: 'invoice',
          livemode: false,
          status: 'paid',
          customer: 'cus_1',
          amount_paid: 3333,
          currency: 'usd',
          billing_reason: 'subscription_update',
          parent: { subscription_details: { subscription: 'sub_1' } },
        },
      ],
      'GET /v1/subscriptions/sub_1': () => [
        200,
        {
          id: 'sub_1',
          object: 'subscription',
          customer: 'cus_1',
          status: 'active',
          livemode: false,
          cancel_at_period_end: false,
          items: {
            object: 'list',
            has_more: false,
            data: [
              {
                id: 'si_1',
                object: 'subscription_item',
                price: { id: 'price_y', object: 'price' },
                quantity: 1,
                current_period_start: 1_800_000_000,
                current_period_end: 1_831_536_000,
              },
            ],
          },
        },
      ],
    });
    await expect(provider.retrieveInvoice('in_up')).resolves.toMatchObject({
      billingReason: 'subscription_update',
      currency: 'usd',
      amountPaidMinorUnits: 3333,
    });
    await expect(provider.retrieveSubscription('sub_1')).resolves.toMatchObject(
      {
        currentPeriodStart: new Date(1_800_000_000_000),
        currentPeriodEnd: new Date(1_831_536_000_000),
      },
    );
  });

  it('pending update applied / expired events re-read the subscription', () => {
    const { stripe, provider } = harness({});
    for (const type of [
      'customer.subscription.pending_update_applied',
      'customer.subscription.pending_update_expired',
    ]) {
      const verified = provider.verifyEvent({
        ...signed(stripe, {
          id: `evt_${type}`,
          object: 'event',
          type,
          created: Math.floor(Date.now() / 1000),
          livemode: false,
          data: {
            object: { id: 'sub_1', object: 'subscription', customer: 'cus_1' },
          },
        }),
      });
      expect(verified.event).toEqual({ kind: 'SUBSCRIPTION_CHANGED' });
      expect(verified.externalSubscriptionId).toBe('sub_1');
    }
  });
});
