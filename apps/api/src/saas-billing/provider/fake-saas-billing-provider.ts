import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { ProviderSubscriptionSnapshot } from '../domain/provider-sync';
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

// SC3a/SC3b — a deterministic, in-memory SaaS billing provider for
// development and tests ONLY (refused in production-like environments; see
// saas-billing-provider-mode.ts). It moves no money and calls nothing.
//
// Events are signed like a real provider's webhooks so the verification
// path is exercised end to end:
//   header  "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}`>"
//   body    {"id","type","created","livemode","data":{...}}
// Operations are idempotent by key (or deterministic by our ids): repeating
// one returns the first result, never a second object. Tests drive the
// provider side through the helpers at the bottom (complete a Checkout,
// change a subscription, settle an invoice).

export const FAKE_SIGNATURE_TOLERANCE_SECONDS = 300;

export type FakeEventType =
  | 'payment_method.authorized'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'subscription.trial_ended'
  | 'subscription.cancel_scheduled'
  | 'subscription.cancel_undone'
  | 'subscription.ended'
  | 'checkout.completed'
  | 'subscription.changed';

export interface FakeEventBody {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: {
    subscription?: string | null;
    customer?: string | null;
    // Metadata — never trusted, only cross-checked.
    tenantId?: string | null;
    reference?: string | null;
    session?: string | null;
    amount?: number | null;
    currency?: string | null;
    periodStart?: number | null;
    periodEnd?: number | null;
  };
}

function sign(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

function parseHeader(
  header: string | undefined,
): { timestamp: number; signatures: string[] } | null {
  if (typeof header !== 'string' || header.length > 1000) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't' && value && /^\d{1,12}$/.test(value)) {
      timestamp = Number(value);
    } else if (key === 'v1' && value && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(value);
    }
  }
  return timestamp === null || signatures.length === 0
    ? null
    : { timestamp, signatures };
}

// 2000-01-01 .. 9999: anything else is not a real time.
function toDate(seconds: unknown): Date | null {
  return typeof seconds === 'number' &&
    Number.isInteger(seconds) &&
    seconds >= 946_684_800 &&
    seconds <= 253_402_300_799
    ? new Date(seconds * 1000)
    : null;
}

function optionalText(value: unknown, max = 255): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : null;
}

const hex = () => randomBytes(8).toString('hex');

interface FakeCheckout extends ProviderCheckoutSession {
  externalPriceId: string;
  trialDays: number;
  requiresPaymentMethod: boolean;
}

export class FakeSaasBillingProvider implements SaasBillingProvider {
  readonly name = 'fake';
  readonly livemode = false;
  readonly available = true;
  readonly products = new Map<string, string>();
  readonly prices = new Map<string, string>();
  private readonly customers = new Map<string, string>();
  readonly checkouts = new Map<string, FakeCheckout>();
  private readonly checkoutsByKey = new Map<string, string>();
  readonly subscriptions = new Map<string, ProviderSubscriptionSnapshot>();
  readonly invoices = new Map<string, ProviderInvoice>();
  readonly calls: Array<{ op: string; key: string }> = [];
  // Test hook: make the next provider call fail (a transient outage).
  failNext: string | null = null;

  constructor(
    private readonly webhookSecret: string = randomBytes(32).toString('hex'),
  ) {
    if (webhookSecret.length < 32) {
      throw new Error('The fake billing webhook secret is too short.');
    }
  }

  private call(op: string, key: string): void {
    this.calls.push({ op, key });
    if (this.failNext !== null) {
      const code = this.failNext;
      this.failNext = null;
      throw new SaasBillingProviderError(code);
    }
  }

  ensureProduct(input: {
    planId: string;
  }): Promise<{ externalProductId: string }> {
    this.call('ensureProduct', input.planId);
    const productId = `fake_prod_${input.planId}`;
    this.products.set(input.planId, productId);
    return Promise.resolve({ externalProductId: productId });
  }

  ensurePrice(input: {
    priceId: string;
  }): Promise<{ externalPriceId: string }> {
    this.call('ensurePrice', input.priceId);
    const existing = this.prices.get(input.priceId);
    const priceId = existing ?? `fake_price_${hex()}`;
    this.prices.set(input.priceId, priceId);
    return Promise.resolve({ externalPriceId: priceId });
  }

  createCustomer(input: {
    idempotencyKey: string;
  }): Promise<{ externalCustomerId: string }> {
    this.call('createCustomer', input.idempotencyKey);
    const existing = this.customers.get(input.idempotencyKey);
    const customerId = existing ?? `fake_cus_${hex()}`;
    this.customers.set(input.idempotencyKey, customerId);
    return Promise.resolve({ externalCustomerId: customerId });
  }

  createCheckoutSession(input: {
    idempotencyKey: string;
    externalCustomerId: string;
    externalPriceId: string;
    trialDays: number;
    requiresPaymentMethod: boolean;
  }): Promise<ProviderCheckoutSession> {
    this.call('createCheckoutSession', input.idempotencyKey);
    const existing = this.checkoutsByKey.get(input.idempotencyKey);
    if (existing) return Promise.resolve(this.view(existing));
    const sessionId = `fake_cs_${hex()}`;
    this.checkouts.set(sessionId, {
      externalSessionId: sessionId,
      status: 'open',
      url: `https://checkout.fake.test/${sessionId}`,
      expiresAt: new Date(Date.now() + 24 * 3600_000),
      externalCustomerId: input.externalCustomerId,
      externalSubscriptionId: null,
      livemode: false,
      externalPriceId: input.externalPriceId,
      trialDays: input.trialDays,
      requiresPaymentMethod: input.requiresPaymentMethod,
    });
    this.checkoutsByKey.set(input.idempotencyKey, sessionId);
    return Promise.resolve(this.view(sessionId));
  }

  private view(sessionId: string): ProviderCheckoutSession {
    const c = this.checkouts.get(sessionId)!;
    return {
      externalSessionId: c.externalSessionId,
      status: c.status,
      url: c.status === 'open' ? c.url : null,
      expiresAt: c.expiresAt,
      externalCustomerId: c.externalCustomerId,
      externalSubscriptionId: c.externalSubscriptionId,
      livemode: false,
    };
  }

  retrieveCheckoutSession(
    externalSessionId: string,
  ): Promise<ProviderCheckoutSession> {
    this.call('retrieveCheckoutSession', externalSessionId);
    if (!this.checkouts.has(externalSessionId)) {
      return Promise.reject(new SaasBillingProviderError('resource_missing'));
    }
    return Promise.resolve(this.view(externalSessionId));
  }

  retrieveSubscription(
    externalSubscriptionId: string,
  ): Promise<ProviderSubscriptionSnapshot> {
    this.call('retrieveSubscription', externalSubscriptionId);
    const snapshot = this.subscriptions.get(externalSubscriptionId);
    return snapshot
      ? Promise.resolve({ ...snapshot })
      : Promise.reject(new SaasBillingProviderError('resource_missing'));
  }

  retrieveInvoice(externalInvoiceId: string): Promise<ProviderInvoice | null> {
    this.call('retrieveInvoice', externalInvoiceId);
    const invoice = this.invoices.get(externalInvoiceId);
    return Promise.resolve(invoice ? { ...invoice } : null);
  }

  // --- test helpers (the provider side) --------------------------------------

  // The owner finished Checkout: the provider created a subscription.
  completeCheckout(
    externalSessionId: string,
    opts: { hasPaymentMethod: boolean; now?: Date },
  ): ProviderSubscriptionSnapshot {
    const checkout = this.checkouts.get(externalSessionId)!;
    const now = opts.now ?? new Date();
    const subscriptionId = `fake_sub_${hex()}`;
    const trial = checkout.trialDays > 0;
    const snapshot: ProviderSubscriptionSnapshot = {
      externalSubscriptionId: subscriptionId,
      externalCustomerId: checkout.externalCustomerId!,
      status: trial ? 'trialing' : 'active',
      livemode: false,
      hasPaymentMethod: opts.hasPaymentMethod,
      cancelAtPeriodEnd: false,
      trialStart: trial ? now : null,
      trialEnd: trial
        ? new Date(now.getTime() + checkout.trialDays * 86_400_000)
        : null,
    };
    this.subscriptions.set(subscriptionId, snapshot);
    checkout.status = 'complete';
    checkout.externalSubscriptionId = subscriptionId;
    return snapshot;
  }

  setSubscription(
    externalSubscriptionId: string,
    change: Partial<ProviderSubscriptionSnapshot>,
  ): void {
    const current = this.subscriptions.get(externalSubscriptionId)!;
    this.subscriptions.set(externalSubscriptionId, { ...current, ...change });
  }

  setInvoice(
    externalInvoiceId: string,
    status: ProviderInvoiceStatus,
    externalSubscriptionId: string | null,
    externalCustomerId: string | null,
  ): void {
    this.invoices.set(externalInvoiceId, {
      externalInvoiceId,
      status,
      externalSubscriptionId,
      externalCustomerId,
      livemode: false,
    });
  }

  expireCheckout(externalSessionId: string): void {
    const checkout = this.checkouts.get(externalSessionId)!;
    checkout.status = 'expired';
  }

  // The signed delivery a real provider would send.
  signEvent(
    body: FakeEventBody,
    at: Date = new Date(),
  ): { rawBody: string; signatureHeader: string } {
    const rawBody = JSON.stringify(body);
    const timestamp = Math.floor(at.getTime() / 1000);
    return {
      rawBody,
      signatureHeader: `t=${timestamp},v1=${sign(this.webhookSecret, timestamp, rawBody)}`,
    };
  }

  verifyEvent(input: {
    rawBody: string | Buffer;
    signatureHeader: string | undefined;
    now?: Date;
  }): VerifiedBillingProviderEvent {
    const rawBody =
      typeof input.rawBody === 'string'
        ? input.rawBody
        : input.rawBody.toString('utf8');
    if (rawBody.length === 0 || rawBody.length > 65_536) {
      throw new BillingEventVerificationError('Unreadable event.');
    }
    const header = parseHeader(input.signatureHeader);
    if (!header) throw new BillingEventVerificationError('Missing signature.');
    const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
    if (
      Math.abs(nowSeconds - header.timestamp) > FAKE_SIGNATURE_TOLERANCE_SECONDS
    ) {
      throw new BillingEventVerificationError(
        'Signature timestamp out of tolerance.',
      );
    }
    const expected = Buffer.from(
      sign(this.webhookSecret, header.timestamp, rawBody),
      'hex',
    );
    const valid = header.signatures.some((candidate) => {
      const given = Buffer.from(candidate, 'hex');
      return (
        given.length === expected.length && timingSafeEqual(given, expected)
      );
    });
    if (!valid) throw new BillingEventVerificationError('Invalid signature.');

    let body: FakeEventBody;
    try {
      body = JSON.parse(rawBody) as FakeEventBody;
    } catch {
      throw new BillingEventVerificationError('Unreadable event.');
    }
    const eventId = optionalText(body?.id);
    const type = optionalText(body?.type, 100);
    const occurredAt = toDate(body?.created);
    if (
      !eventId ||
      !type ||
      !occurredAt ||
      typeof body.livemode !== 'boolean'
    ) {
      throw new BillingEventVerificationError('Incomplete event.');
    }
    // An event cannot have happened after it was signed.
    if (
      occurredAt.getTime() >
      (header.timestamp + FAKE_SIGNATURE_TOLERANCE_SECONDS) * 1000
    ) {
      throw new BillingEventVerificationError('Event time is in the future.');
    }
    const data =
      typeof body.data === 'object' && body.data !== null ? body.data : {};
    return {
      provider: this.name,
      externalEventId: eventId,
      providerType: type,
      livemode: body.livemode,
      occurredAt,
      payloadDigest: createHash('sha256').update(rawBody).digest('hex'),
      externalSubscriptionId: optionalText(data.subscription),
      externalCustomerId: optionalText(data.customer),
      claimedTenantId: optionalText(data.tenantId),
      event: this.normalize(type, data),
    };
  }

  private normalize(
    type: string,
    data: FakeEventBody['data'],
  ): ProviderLifecycleEvent {
    const reference = optionalText(data.reference);
    switch (type as FakeEventType) {
      case 'payment_method.authorized':
        return { kind: 'PAYMENT_AUTHORIZED' };
      case 'invoice.paid': {
        const amount = data.amount;
        const currency = optionalText(data.currency, 3);
        return reference &&
          currency &&
          typeof amount === 'number' &&
          Number.isInteger(amount) &&
          amount >= 0
          ? {
              kind: 'PAYMENT_SUCCEEDED',
              reference,
              amountMinorUnits: amount,
              currency: currency.toUpperCase(),
              periodStart: toDate(data.periodStart),
              periodEnd: toDate(data.periodEnd),
            }
          : { kind: 'UNSUPPORTED' };
      }
      case 'invoice.payment_failed':
        return reference
          ? { kind: 'PAYMENT_FAILED', reference }
          : { kind: 'UNSUPPORTED' };
      case 'subscription.trial_ended':
        return { kind: 'TRIAL_ENDED' };
      case 'subscription.cancel_scheduled':
        return { kind: 'CANCEL_SCHEDULED' };
      case 'subscription.cancel_undone':
        return { kind: 'CANCEL_UNDONE' };
      case 'subscription.ended':
        return { kind: 'SUBSCRIPTION_ENDED' };
      case 'checkout.completed': {
        const session = optionalText(data.session);
        return session
          ? { kind: 'CHECKOUT_COMPLETED', externalSessionId: session }
          : { kind: 'UNSUPPORTED' };
      }
      case 'subscription.changed':
        return { kind: 'SUBSCRIPTION_CHANGED' };
      default:
        return { kind: 'UNSUPPORTED' };
    }
  }
}
