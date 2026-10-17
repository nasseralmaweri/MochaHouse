import type { ProviderSubscriptionSnapshot } from '../domain/provider-sync';
import type { ProviderPortalConfiguration } from './portal-configuration';

// SC3a/SC3b — the CENTERIVO SaaS subscription-billing provider boundary.
//
// Deliberately SEPARATE from the restaurant payment boundary
// (PaymentProvider / PAYMENT_PROVIDER): its own interface, injection token,
// configuration and secrets, and no shared code (the separation guard spec
// enforces this). SaaS billing charges a business for CENTERIVO; restaurant
// payments charge a business's customers. They never meet.
//
// Only what the billing lifecycle needs. A provider never decides
// entitlements: it reports facts (verified events, live reads) and performs
// requested operations with the caller's deterministic idempotency key.

export const SAAS_BILLING_PROVIDER = Symbol('SAAS_BILLING_PROVIDER');

// What a verified provider event means for the lifecycle (provider-neutral).
export type ProviderLifecycleEvent =
  | { kind: 'PAYMENT_AUTHORIZED' }
  | {
      kind: 'PAYMENT_SUCCEEDED';
      // The provider invoice that was paid.
      reference: string;
      // What was actually collected (integer minor units).
      amountMinorUnits: number;
      currency: string;
      periodStart: Date | null;
      periodEnd: Date | null;
    }
  | { kind: 'PAYMENT_FAILED'; reference: string }
  | { kind: 'TRIAL_ENDED' }
  | { kind: 'CANCEL_SCHEDULED' }
  | { kind: 'CANCEL_UNDONE' }
  | { kind: 'SUBSCRIPTION_ENDED' }
  // SC3b — a hosted Checkout completed: the provider session id, matched
  // ONLY to a session we created.
  | { kind: 'CHECKOUT_COMPLETED'; externalSessionId: string }
  // SC3b — the provider subscription changed: the live subscription is
  // re-read and our state brought in line with it (provider-sync.ts).
  | { kind: 'SUBSCRIPTION_CHANGED' }
  // A type the lifecycle does not act on: recorded and ignored.
  | { kind: 'UNSUPPORTED' };

export interface VerifiedBillingProviderEvent {
  provider: string;
  externalEventId: string;
  // The provider's own event type (recorded for audit).
  providerType: string;
  livemode: boolean;
  occurredAt: Date;
  // SHA-256 of the event's stable identifying content (never delivery
  // counters). The payload itself is not stored.
  payloadDigest: string;
  externalSubscriptionId: string | null;
  externalCustomerId: string | null;
  // A business id found in the event's metadata. NEVER used to find the
  // business — only cross-checked against the business matched through our
  // own stored provider ids; a mismatch rejects the event.
  claimedTenantId: string | null;
  event: ProviderLifecycleEvent;
}

export type ProviderCheckoutStatus = 'open' | 'complete' | 'expired';

export interface ProviderCheckoutSession {
  externalSessionId: string;
  status: ProviderCheckoutStatus;
  // The hosted page (only while open).
  url: string | null;
  expiresAt: Date | null;
  externalCustomerId: string | null;
  externalSubscriptionId: string | null;
  livemode: boolean;
}

export type ProviderInvoiceStatus =
  'draft' | 'open' | 'paid' | 'uncollectible' | 'void';

export interface ProviderInvoice {
  externalInvoiceId: string;
  status: ProviderInvoiceStatus;
  externalSubscriptionId: string | null;
  externalCustomerId: string | null;
  livemode: boolean;
  // SC3c-2 — what was actually collected (integer minor units).
  amountPaidMinorUnits: number;
  // SC3d-2 — why the provider created it ("subscription_update" for a plan
  // change) and its currency (lower-case). Optional: undefined = not read.
  billingReason?: string | null;
  currency?: string | null;
}

// SC3c-2 — an invoice that can be paid on the provider's hosted page.
export interface ProviderPayableInvoice extends ProviderInvoice {
  amountDueMinorUnits: number;
  currency: string;
  createdAt: Date;
  // The provider's own hosted payment page for this invoice.
  hostedInvoiceUrl: string | null;
}

export class BillingEventVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingEventVerificationError';
  }
}

export class SaasBillingUnavailableError extends Error {
  constructor() {
    super('SaaS billing is not configured.');
    this.name = 'SaasBillingUnavailableError';
  }
}

// SC3d-1 — the provider's OWN calculation of a price change (nothing
// changes). Minor units, the provider's (lower-case) currency.
export interface ProviderChargePreview {
  livemode: boolean;
  currency: string;
  // What would be charged now (after credits, discounts and tax).
  amountDueMinorUnits: number;
  // The invoice total (negative when credits exceed the charge).
  totalMinorUnits: number;
  taxMinorUnits: number;
  discountMinorUnits: number;
  // The net of the proration lines (the unused-time credit is negative).
  prorationMinorUnits: number;
}

export interface ProviderRecurringPreview {
  livemode: boolean;
  currency: string;
  // The recurring bill after the change (discounts and tax included).
  totalMinorUnits: number;
}

// SC3d-1 — the result of an immediate price change sent with "apply only if
// paid": the subscription as the provider now reports it, the invoice the
// change created, and whether the change is still waiting for payment.
export interface ProviderPriceChangeResult {
  snapshot: ProviderSubscriptionSnapshot;
  externalInvoiceId: string | null;
  pendingUpdate: boolean;
}

// A provider call that failed (network, provider outage, rate limit):
// retryable. Never carries provider error text beyond a short code.
export class SaasBillingProviderError extends Error {
  constructor(readonly code: string) {
    super(`Billing provider request failed (${code}).`);
    this.name = 'SaasBillingProviderError';
  }
}

export interface SaasBillingProvider {
  readonly name: string;
  readonly livemode: boolean;
  readonly available: boolean;

  // The plan's provider product, created once (deterministic: the same plan
  // always yields the same product, under retries and concurrent requests).
  ensureProduct(input: {
    planId: string;
    planName: string;
  }): Promise<{ externalProductId: string }>;

  // A list price's provider price, created once per price (deterministic, as
  // above). Amount, currency and interval come from OUR price row.
  ensurePrice(input: {
    priceId: string;
    externalProductId: string;
    amountMinorUnits: number;
    currency: string;
    interval: 'MONTH' | 'YEAR';
  }): Promise<{ externalPriceId: string }>;

  createCustomer(input: {
    idempotencyKey: string;
    tenantId: string;
    businessName: string;
    billingEmail: string;
  }): Promise<{ externalCustomerId: string }>;

  // A hosted Checkout for a subscription to ONE price. With trialDays > 0
  // and requiresPaymentMethod false, the provider must END the subscription
  // when the trial ends without a payment method (never charge).
  createCheckoutSession(input: {
    idempotencyKey: string;
    checkoutSessionId: string;
    tenantId: string;
    externalCustomerId: string;
    externalPriceId: string;
    trialDays: number;
    requiresPaymentMethod: boolean;
    successUrl: string;
    cancelUrl: string;
  }): Promise<ProviderCheckoutSession>;

  retrieveCheckoutSession(
    externalSessionId: string,
  ): Promise<ProviderCheckoutSession>;

  retrieveSubscription(
    externalSubscriptionId: string,
  ): Promise<ProviderSubscriptionSnapshot>;

  // null when the provider has no such invoice.
  retrieveInvoice(externalInvoiceId: string): Promise<ProviderInvoice | null>;

  // SC3c-2 — the subscription's OPEN invoices, oldest first.
  listOpenInvoices(
    externalSubscriptionId: string,
  ): Promise<ProviderPayableInvoice[]>;

  // SC3c-2 — the Customer Portal. The configuration (operator-configured)
  // is read back and checked before every session (portal-configuration.ts).
  readonly portalConfigurationId: string | null;
  readonly expectedAccountId: string | null;
  retrievePortalConfiguration(
    configurationId: string,
  ): Promise<ProviderPortalConfiguration>;
  createPortalSession(input: {
    externalCustomerId: string;
    configurationId: string;
    returnUrl: string;
  }): Promise<{ url: string; livemode: boolean }>;

  // --- SC3d-1: plan changes ---------------------------------------------------
  // Previews change NOTHING. The change methods are the foundation for later
  // SC3d steps (no route calls them in SC3d-1):
  //   * an immediate change is ALWAYS sent so that the provider applies it
  //     only if the invoice it creates is paid ("pending if incomplete"),
  //     prorated and invoiced at once, at the previewed proration date;
  //   * a period-end change is a subscription schedule that releases the
  //     subscription after it;
  //   * removing a scheduled change RELEASES the schedule — the subscription
  //     stays exactly as it is (a schedule is never cancelled: that would end
  //     the subscription).

  // The charge NOW for moving one item to another price, prorated at
  // `prorationDate` (which the real change must reuse).
  previewImmediateChange(input: {
    externalSubscriptionId: string;
    externalItemId: string;
    toExternalPriceId: string;
    prorationDate: Date;
  }): Promise<ProviderChargePreview>;

  // The recurring bill once the item is on the other price.
  previewRecurring(input: {
    externalSubscriptionId: string;
    externalItemId: string;
    toExternalPriceId: string;
  }): Promise<ProviderRecurringPreview>;

  changePriceNow(input: {
    idempotencyKey: string;
    externalSubscriptionId: string;
    externalItemId: string;
    toExternalPriceId: string;
    prorationDate: Date;
  }): Promise<ProviderPriceChangeResult>;

  schedulePriceChangeAtPeriodEnd(input: {
    idempotencyKey: string;
    externalSubscriptionId: string;
    fromExternalPriceId: string;
    toExternalPriceId: string;
    toInterval: 'MONTH' | 'YEAR';
  }): Promise<{ externalScheduleId: string }>;

  releaseSchedule(input: {
    idempotencyKey: string;
    externalScheduleId: string;
  }): Promise<{ releasedSubscriptionId: string | null }>;

  // Verifies an incoming event's signature and freshness and normalizes it.
  // Throws BillingEventVerificationError for anything unverifiable.
  verifyEvent(input: {
    rawBody: string | Buffer;
    signatureHeader: string | undefined;
    now?: Date;
  }): VerifiedBillingProviderEvent;
}

function unavailable(): Promise<never> {
  return Promise.reject(new SaasBillingUnavailableError());
}

// Bound when no SaaS billing provider is configured: every operation is
// refused and no event verifies.
export class DisabledSaasBillingProvider implements SaasBillingProvider {
  readonly name = 'disabled';
  readonly livemode = false;
  readonly available = false;

  ensureProduct = unavailable;
  ensurePrice = unavailable;
  createCustomer = unavailable;
  createCheckoutSession = unavailable;
  retrieveCheckoutSession = unavailable;
  retrieveSubscription = unavailable;
  retrieveInvoice = unavailable;
  listOpenInvoices = unavailable;
  readonly portalConfigurationId = null;
  readonly expectedAccountId = null;
  retrievePortalConfiguration = unavailable;
  createPortalSession = unavailable;
  previewImmediateChange = unavailable;
  previewRecurring = unavailable;
  changePriceNow = unavailable;
  schedulePriceChangeAtPeriodEnd = unavailable;
  releaseSchedule = unavailable;
  verifyEvent(): VerifiedBillingProviderEvent {
    throw new BillingEventVerificationError('SaaS billing is not configured.');
  }
}
