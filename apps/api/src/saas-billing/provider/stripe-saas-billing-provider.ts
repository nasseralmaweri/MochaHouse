import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import type {
  PaymentMethodSource,
  ProviderSubscriptionSnapshot,
  ProviderSubscriptionStatus,
} from '../domain/provider-sync';
import {
  BillingEventVerificationError,
  SaasBillingProviderError,
  type ProviderCheckoutSession,
  type ProviderInvoice,
  type ProviderInvoiceStatus,
  type ProviderLifecycleEvent,
  type SaasBillingProvider,
  type VerifiedBillingProviderEvent,
} from './saas-billing-provider';

// SC3b — CENTERIVO SaaS billing through Stripe Billing, TEST MODE ONLY (F4):
// the configuration refuses live keys (saas-billing-provider-mode.ts), and
// every object read back or event received must be test-mode (livemode
// false) or it is refused.
//
// Pinned (F1): the SDK version (package.json, exact) and the API version
// below — the SDK's own version, so request and response shapes are the
// ones its types describe.
//
// Deterministic objects (no duplicates under retries or concurrency):
//   * a plan's product has OUR id: centerivo_plan_<planId>; a second create
//     is "already exists" and the existing product is read and checked;
//   * a price has the lookup key centerivo_price_<priceId> and a
//     deterministic idempotency key; an existing price is found by its
//     lookup key and must match our amount, currency, interval and product;
//   * customers and Checkout sessions use the caller's deterministic
//     idempotency keys.
export const STRIPE_API_VERSION = '2026-08-26.dahlia' as const;

const PROVIDER = 'stripe';
// Stripe's documented default signature tolerance.
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

export interface StripeBillingConfig {
  webhookSecret: string;
}

function productId(planId: string): string {
  return `centerivo_plan_${planId}`;
}

function priceLookupKey(priceId: string): string {
  return `centerivo_price_${priceId}`;
}

// Where the payment method Stripe will charge automatically comes from.
// Checkout (subscription mode) records the method it collected as the
// subscription's default_payment_method; when a subscription has none,
// Stripe charges the customer's default (invoice_settings
// .default_payment_method, or a legacy default source). A send_invoice
// subscription is never charged automatically.
function paymentMethodSource(sub: Stripe.Subscription): PaymentMethodSource {
  if (sub.collection_method === 'send_invoice') return null;
  if (
    id(sub.default_payment_method) !== null ||
    id(sub.default_source) !== null
  ) {
    return 'SUBSCRIPTION';
  }
  const customer = sub.customer;
  if (
    typeof customer === 'object' &&
    customer !== null &&
    !('deleted' in customer && customer.deleted === true)
  ) {
    const live = customer;
    if (
      id(live.invoice_settings?.default_payment_method) !== null ||
      id(live.default_source) !== null
    ) {
      return 'CUSTOMER_DEFAULT';
    }
  }
  return null;
}

function id(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  ) {
    return (value as { id: string }).id;
  }
  return null;
}

function date(seconds: unknown): Date | null {
  return typeof seconds === 'number' && Number.isInteger(seconds) && seconds > 0
    ? new Date(seconds * 1000)
    : null;
}

function text(value: unknown, max = 255): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : null;
}

// A provider failure becomes a short, retryable code — never provider text.
function providerError(error: unknown): SaasBillingProviderError {
  if (error instanceof SaasBillingProviderError) return error;
  const e = error as { type?: unknown; code?: unknown };
  const code =
    (typeof e?.code === 'string' && e.code) ||
    (typeof e?.type === 'string' && e.type) ||
    'unknown';
  return new SaasBillingProviderError(code.slice(0, 60));
}

const SUBSCRIPTION_STATUSES: readonly ProviderSubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'paused',
];

const INVOICE_STATUSES: readonly ProviderInvoiceStatus[] = [
  'draft',
  'open',
  'paid',
  'uncollectible',
  'void',
];

export class StripeSaasBillingProvider implements SaasBillingProvider {
  readonly name = PROVIDER;
  readonly livemode = false;
  readonly available = true;

  constructor(
    private readonly stripe: Stripe,
    private readonly config: StripeBillingConfig,
  ) {}

  static create(secretKey: string, config: StripeBillingConfig) {
    return new StripeSaasBillingProvider(
      new Stripe(secretKey, {
        apiVersion: STRIPE_API_VERSION,
        maxNetworkRetries: 2,
        timeout: 20_000,
        telemetry: false,
        appInfo: { name: 'CENTERIVO SaaS billing' },
      }),
      config,
    );
  }

  private assertTestMode(livemode: unknown): void {
    if (livemode !== false) {
      throw new SaasBillingProviderError('live_mode_refused');
    }
  }

  async ensureProduct(input: {
    planId: string;
    planName: string;
  }): Promise<{ externalProductId: string }> {
    const productIdValue = productId(input.planId);
    try {
      const product = await this.stripe.products.create(
        {
          id: productIdValue,
          name: input.planName.slice(0, 250),
          metadata: { centerivo_plan_id: input.planId },
        },
        { idempotencyKey: `centerivo-product-${input.planId}` },
      );
      this.assertTestMode(product.livemode);
      return { externalProductId: product.id };
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code !== 'resource_already_exists') throw providerError(error);
    }
    // Created earlier (another request or a retry): read and check it.
    try {
      const existing = await this.stripe.products.retrieve(productIdValue);
      this.assertTestMode(existing.livemode);
      if (existing.metadata?.centerivo_plan_id !== input.planId) {
        throw new SaasBillingProviderError('product_mismatch');
      }
      return { externalProductId: existing.id };
    } catch (error) {
      throw providerError(error);
    }
  }

  async ensurePrice(input: {
    priceId: string;
    externalProductId: string;
    amountMinorUnits: number;
    currency: string;
    interval: 'MONTH' | 'YEAR';
  }): Promise<{ externalPriceId: string }> {
    const lookupKey = priceLookupKey(input.priceId);
    const interval = input.interval === 'MONTH' ? 'month' : 'year';
    const currency = input.currency.toLowerCase();
    const matches = (price: Stripe.Price): boolean =>
      price.livemode === false &&
      price.unit_amount === input.amountMinorUnits &&
      price.currency === currency &&
      price.recurring?.interval === interval &&
      price.recurring?.interval_count === 1 &&
      id(price.product) === input.externalProductId &&
      price.metadata?.centerivo_price_id === input.priceId;
    try {
      const found = await this.stripe.prices.list({
        lookup_keys: [lookupKey],
        limit: 1,
      });
      if (found.data.length > 0) {
        if (!matches(found.data[0])) {
          throw new SaasBillingProviderError('price_mismatch');
        }
        return { externalPriceId: found.data[0].id };
      }
      const created = await this.stripe.prices.create(
        {
          product: input.externalProductId,
          unit_amount: input.amountMinorUnits,
          currency,
          recurring: { interval, interval_count: 1 },
          lookup_key: lookupKey,
          metadata: { centerivo_price_id: input.priceId },
        },
        { idempotencyKey: `centerivo-price-${input.priceId}` },
      );
      if (!matches(created)) {
        throw new SaasBillingProviderError('price_mismatch');
      }
      return { externalPriceId: created.id };
    } catch (error) {
      throw providerError(error);
    }
  }

  async createCustomer(input: {
    idempotencyKey: string;
    tenantId: string;
    businessName: string;
    billingEmail: string;
  }): Promise<{ externalCustomerId: string }> {
    try {
      const customer = await this.stripe.customers.create(
        {
          name: input.businessName.slice(0, 250),
          email: input.billingEmail,
          // Informational only: a webhook never finds a business by this.
          metadata: { centerivo_tenant_id: input.tenantId },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      this.assertTestMode(customer.livemode);
      return { externalCustomerId: customer.id };
    } catch (error) {
      throw providerError(error);
    }
  }

  async createCheckoutSession(input: {
    idempotencyKey: string;
    checkoutSessionId: string;
    tenantId: string;
    externalCustomerId: string;
    externalPriceId: string;
    trialDays: number;
    requiresPaymentMethod: boolean;
    successUrl: string;
    cancelUrl: string;
  }): Promise<ProviderCheckoutSession> {
    const trial = input.trialDays > 0;
    try {
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          customer: input.externalCustomerId,
          line_items: [{ price: input.externalPriceId, quantity: 1 }],
          client_reference_id: input.checkoutSessionId,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          // A cardless trial: no payment method is collected unless one is
          // needed. Otherwise one is always collected.
          payment_method_collection:
            trial && !input.requiresPaymentMethod ? 'if_required' : 'always',
          metadata: {
            centerivo_tenant_id: input.tenantId,
            centerivo_checkout_id: input.checkoutSessionId,
          },
          subscription_data: {
            metadata: { centerivo_tenant_id: input.tenantId },
            ...(trial
              ? {
                  trial_period_days: input.trialDays,
                  // F3 / E5: a trial that ends without a payment method is
                  // ENDED by Stripe — never charged.
                  trial_settings: {
                    end_behavior: { missing_payment_method: 'cancel' },
                  },
                }
              : {}),
          },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return this.toCheckout(session);
    } catch (error) {
      throw providerError(error);
    }
  }

  async retrieveCheckoutSession(
    externalSessionId: string,
  ): Promise<ProviderCheckoutSession> {
    try {
      return this.toCheckout(
        await this.stripe.checkout.sessions.retrieve(externalSessionId),
      );
    } catch (error) {
      throw providerError(error);
    }
  }

  private toCheckout(
    session: Stripe.Checkout.Session,
  ): ProviderCheckoutSession {
    this.assertTestMode(session.livemode);
    const status: ProviderCheckoutSession['status'] =
      session.status === 'complete'
        ? 'complete'
        : session.status === 'expired'
          ? 'expired'
          : 'open';
    return {
      externalSessionId: session.id,
      status,
      url: status === 'open' ? (session.url ?? null) : null,
      expiresAt: date(session.expires_at),
      externalCustomerId: id(session.customer),
      externalSubscriptionId: id(session.subscription),
      livemode: session.livemode,
    };
  }

  async retrieveSubscription(
    externalSubscriptionId: string,
  ): Promise<ProviderSubscriptionSnapshot> {
    try {
      // The customer is expanded: its default payment method counts too.
      const sub = await this.stripe.subscriptions.retrieve(
        externalSubscriptionId,
        { expand: ['customer'] },
      );
      this.assertTestMode(sub.livemode);
      if (typeof sub.customer === 'object' && 'livemode' in sub.customer) {
        this.assertTestMode(sub.customer.livemode);
      }
      const source = paymentMethodSource(sub);
      const status = SUBSCRIPTION_STATUSES.includes(
        sub.status as ProviderSubscriptionStatus,
      )
        ? (sub.status as ProviderSubscriptionStatus)
        : 'incomplete';
      const customer = id(sub.customer);
      if (!customer)
        throw new SaasBillingProviderError('subscription_customer');
      return {
        externalSubscriptionId: sub.id,
        externalCustomerId: customer,
        status,
        livemode: sub.livemode,
        hasPaymentMethod: source !== null,
        paymentMethodSource: source,
        cancelAtPeriodEnd: sub.cancel_at_period_end === true,
        trialStart: date(sub.trial_start),
        trialEnd: date(sub.trial_end),
      };
    } catch (error) {
      throw providerError(error);
    }
  }

  async retrieveInvoice(
    externalInvoiceId: string,
  ): Promise<ProviderInvoice | null> {
    try {
      const invoice = await this.stripe.invoices.retrieve(externalInvoiceId);
      this.assertTestMode(invoice.livemode);
      const status = INVOICE_STATUSES.includes(
        invoice.status as ProviderInvoiceStatus,
      )
        ? (invoice.status as ProviderInvoiceStatus)
        : 'open';
      return {
        externalInvoiceId: invoice.id ?? externalInvoiceId,
        status,
        externalSubscriptionId: invoiceSubscription(invoice),
        externalCustomerId: id(invoice.customer),
        livemode: invoice.livemode,
      };
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'resource_missing') {
        return null;
      }
      throw providerError(error);
    }
  }

  verifyEvent(input: {
    rawBody: string | Buffer;
    signatureHeader: string | undefined;
    now?: Date;
  }): VerifiedBillingProviderEvent {
    if (
      typeof input.signatureHeader !== 'string' ||
      input.signatureHeader.length > 2000
    ) {
      throw new BillingEventVerificationError('Missing signature.');
    }
    let event: Stripe.Event;
    try {
      // The ORIGINAL raw bytes: a re-serialized body would not verify.
      event = this.stripe.webhooks.constructEvent(
        input.rawBody,
        input.signatureHeader,
        this.config.webhookSecret,
        STRIPE_SIGNATURE_TOLERANCE_SECONDS,
        undefined,
        input.now ? Math.floor(input.now.getTime() / 1000) : undefined,
      );
    } catch {
      throw new BillingEventVerificationError('Invalid signature.');
    }
    const occurredAt = date(event.created);
    if (!text(event.id) || !text(event.type, 100) || !occurredAt) {
      throw new BillingEventVerificationError('Incomplete event.');
    }
    const object = event.data.object as unknown as Record<string, unknown>;
    const normalized = normalize(event.type, object);
    return {
      provider: PROVIDER,
      externalEventId: event.id,
      providerType: event.type,
      livemode: event.livemode,
      occurredAt,
      // Stable content only: never delivery counters such as
      // pending_webhooks or the request block.
      payloadDigest: createHash('sha256')
        .update(
          JSON.stringify({
            id: event.id,
            type: event.type,
            created: event.created,
            livemode: event.livemode,
            object: event.data.object,
          }),
        )
        .digest('hex'),
      externalSubscriptionId: normalized.externalSubscriptionId,
      externalCustomerId: id(object.customer),
      claimedTenantId: metadataTenant(object),
      event: normalized.event,
    };
  }
}

function invoiceSubscription(invoice: unknown): string | null {
  const record = invoice as {
    parent?: {
      subscription_details?: { subscription?: unknown } | null;
    } | null;
    subscription?: unknown;
  };
  return (
    id(record.parent?.subscription_details?.subscription) ??
    id(record.subscription)
  );
}

function metadataTenant(object: Record<string, unknown>): string | null {
  const metadata = object.metadata as Record<string, unknown> | undefined;
  return text(metadata?.centerivo_tenant_id, 64);
}

function normalize(
  type: string,
  object: Record<string, unknown>,
): { event: ProviderLifecycleEvent; externalSubscriptionId: string | null } {
  switch (type) {
    case 'checkout.session.completed': {
      const sessionId = text(object.id);
      return object.mode === 'subscription' && sessionId
        ? {
            event: { kind: 'CHECKOUT_COMPLETED', externalSessionId: sessionId },
            externalSubscriptionId: id(object.subscription),
          }
        : { event: { kind: 'UNSUPPORTED' }, externalSubscriptionId: null };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return {
        event: { kind: 'SUBSCRIPTION_CHANGED' },
        externalSubscriptionId: text(object.id),
      };
    case 'invoice.paid': {
      const reference = text(object.id);
      const amount = object.amount_paid;
      const currency = text(object.currency, 3);
      const line = (
        object.lines as {
          data?: Array<{ period?: { start?: unknown; end?: unknown } }>;
        }
      )?.data?.[0];
      return reference &&
        currency &&
        typeof amount === 'number' &&
        Number.isInteger(amount) &&
        amount >= 0
        ? {
            event: {
              kind: 'PAYMENT_SUCCEEDED',
              reference,
              amountMinorUnits: amount,
              currency: currency.toUpperCase(),
              periodStart: date(line?.period?.start),
              periodEnd: date(line?.period?.end),
            },
            externalSubscriptionId: invoiceSubscription(object),
          }
        : { event: { kind: 'UNSUPPORTED' }, externalSubscriptionId: null };
    }
    case 'invoice.payment_failed': {
      const reference = text(object.id);
      return reference
        ? {
            event: { kind: 'PAYMENT_FAILED', reference },
            externalSubscriptionId: invoiceSubscription(object),
          }
        : { event: { kind: 'UNSUPPORTED' }, externalSubscriptionId: null };
    }
    default:
      return { event: { kind: 'UNSUPPORTED' }, externalSubscriptionId: null };
  }
}
