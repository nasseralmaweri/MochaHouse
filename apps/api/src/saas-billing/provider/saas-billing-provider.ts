import type {
  PaymentMethodSource,
  ProviderSubscriptionSnapshot,
} from '../domain/provider-sync';
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
  // SC3e-1 — an invoice (or a credit note on it) changed: its live record
  // is re-read for the business's billing history (nothing else changes).
  | { kind: 'INVOICE_CHANGED'; reference: string }
  // SC3e-3 — a refund was created or changed on a payment (the payment
  // intent): the invoice it paid is reconciled (refunds and credits).
  | { kind: 'REFUND_CHANGED'; paymentIntentId: string }
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
  // SC3e-1 — the full record for the billing history, from the same read
  // (undefined: not read).
  record?: ProviderInvoiceRecord | null;
}

// SC3e-1 — an invoice as the billing history records it. The document links
// are only ever handed to the browser for one request; never stored.
export interface ProviderInvoiceRecord {
  externalInvoiceId: string;
  externalCustomerId: string | null;
  externalSubscriptionId: string | null;
  livemode: boolean;
  number: string | null;
  status: ProviderInvoiceStatus;
  billingReason: string | null;
  // Lower-case ISO currency.
  currency: string;
  totalMinorUnits: number;
  amountDueMinorUnits: number;
  amountPaidMinorUnits: number;
  amountRemainingMinorUnits: number;
  // Credit notes after payment (refunds or account credits).
  postPaymentCreditMinorUnits: number;
  // Credit notes before payment, and account balance applied to it.
  prePaymentCreditMinorUnits: number;
  balanceAppliedMinorUnits: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  issuedAt: Date;
  paidAt: Date | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
}

// SC3e-1 — the payment method the provider will charge, reduced to what may
// be shown (brand, last four digits, expiry). Never a card number,
// fingerprint, billing address or provider payment-method id.
export interface ProviderPaymentMethodSummary {
  externalSubscriptionId: string;
  externalCustomerId: string | null;
  livemode: boolean;
  source: PaymentMethodSource;
  // card | us_bank_account | sepa_debit | link | … (null: none)
  type: string | null;
  card: {
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
  } | null;
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

// SC3d-3 — a subscription schedule as the provider holds it (its phases'
// prices and dates), to compare with the change we scheduled.
export interface ProviderSchedule {
  externalScheduleId: string;
  livemode: boolean;
  // not_started | active | completed | released | canceled
  status: string;
  // The subscription it manages (or released).
  externalSubscriptionId: string | null;
  phases: {
    externalPriceId: string | null;
    quantity: number;
    startDate: Date | null;
    endDate: Date | null;
    trialEnd: Date | null;
  }[];
}

// --- SC3e-3: refunds and credits as credit notes ---------------------------------

// A paid invoice as an adjustment needs it: its lines (before tax), what was
// paid and what was already refunded or credited (credit notes, and refunds
// made on its payments outside them).
export interface ProviderAdjustableInvoice {
  externalInvoiceId: string;
  externalCustomerId: string | null;
  externalSubscriptionId: string | null;
  livemode: boolean;
  status: ProviderInvoiceStatus;
  currency: string;
  amountPaidMinorUnits: number;
  // Credit notes issued after payment (refunds and credits).
  postPaymentCreditMinorUnits: number;
  lines: {
    externalLineId: string;
    description: string | null;
    amountMinorUnits: number;
    periodStart: Date | null;
    periodEnd: Date | null;
  }[];
  // The payment intents that paid it (charges a refund can go back to).
  paymentIntentIds: string[];
  // On those charges: captured, and refunded so far.
  chargeCapturedMinorUnits: number;
  chargeRefundedMinorUnits: number;
}

export interface ProviderCreditNoteInput {
  externalInvoiceId: string;
  // REFUND: to the original payment method; CREDIT: the customer's balance,
  // toward future invoices.
  kind: 'REFUND' | 'CREDIT';
  // Invoice lines and the pre-tax amount credited on each (the provider adds
  // the tax).
  lines: { externalLineId: string; amountMinorUnits: number }[];
}

export interface ProviderCreditNote {
  externalCreditNoteId: string;
  externalInvoiceId: string | null;
  livemode: boolean;
  status: string;
  currency: string;
  totalMinorUnits: number;
  taxMinorUnits: number;
  outOfBandMinorUnits: number;
  refunds: { externalRefundId: string; amountMinorUnits: number }[];
  // Ours: the adjustment it was issued for (credit-note metadata).
  centerivoAdjustmentId: string | null;
}

export interface ProviderRefund {
  externalRefundId: string;
  livemode: boolean;
  // succeeded | pending | requires_action | failed | canceled
  status: string;
  amountMinorUnits: number;
  currency: string;
  paymentIntentId: string | null;
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

  // SC3e-1 — every invoice of a subscription (newest first, capped), for
  // the reconciliation sweep's history backfill.
  listInvoices(
    externalSubscriptionId: string,
  ): Promise<ProviderInvoiceRecord[]>;

  // SC3e-1 — what may be shown of the payment method the provider charges.
  retrievePaymentMethod(
    externalSubscriptionId: string,
  ): Promise<ProviderPaymentMethodSummary>;

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

  // SC3e-3 — refunds and credits as credit notes (test mode only). The
  // provider computes every amount and tax; nothing is calculated here.
  retrieveAdjustableInvoice(
    externalInvoiceId: string,
  ): Promise<ProviderAdjustableInvoice | null>;
  // Nothing is created.
  previewCreditNote(input: ProviderCreditNoteInput): Promise<{
    currency: string;
    totalMinorUnits: number;
    taxMinorUnits: number;
  }>;
  // `totalMinorUnits` is the previewed total, allocated to the refund or
  // the credit; `adjustmentId` is recorded on the credit note.
  createCreditNote(input: {
    idempotencyKey: string;
    adjustmentId: string;
    note: ProviderCreditNoteInput;
    totalMinorUnits: number;
  }): Promise<ProviderCreditNote>;
  listCreditNotes(externalInvoiceId: string): Promise<ProviderCreditNote[]>;
  // Every refund on the invoice's payments (with or without a credit note).
  listInvoiceRefunds(externalInvoiceId: string): Promise<ProviderRefund[]>;
  // The invoice a payment (intent) paid (null: none).
  findInvoiceForPayment(paymentIntentId: string): Promise<string | null>;

  // SC3e-2 — schedules (true) or undoes (false) the subscription's
  // cancellation at the end of the current period (owner decision D2).
  // Never cancels anything immediately and never refunds; the caller
  // re-reads the subscription to verify what the provider accepted.
  setCancelAtPeriodEnd(input: {
    idempotencyKey: string;
    externalSubscriptionId: string;
    cancelAtPeriodEnd: boolean;
  }): Promise<void>;

  // SC3e-2 — every unpaid invoice of the customer (open or uncollectible,
  // across all its subscriptions — current and historical), owner decision D3.
  listUnpaidCustomerInvoices(
    externalCustomerId: string,
  ): Promise<ProviderPayableInvoice[]>;

  releaseSchedule(input: {
    idempotencyKey: string;
    externalScheduleId: string;
  }): Promise<{ releasedSubscriptionId: string | null }>;

  // SC3d-3 — read a schedule (null: the provider has none).
  retrieveSchedule(
    externalScheduleId: string,
  ): Promise<ProviderSchedule | null>;

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
  listInvoices = unavailable;
  retrievePaymentMethod = unavailable;
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
  setCancelAtPeriodEnd = unavailable;
  retrieveAdjustableInvoice = unavailable;
  previewCreditNote = unavailable;
  createCreditNote = unavailable;
  listCreditNotes = unavailable;
  listInvoiceRefunds = unavailable;
  findInvoiceForPayment = unavailable;
  listUnpaidCustomerInvoices = unavailable;
  retrieveSchedule = unavailable;
  verifyEvent(): VerifiedBillingProviderEvent {
    throw new BillingEventVerificationError('SaaS billing is not configured.');
  }
}
