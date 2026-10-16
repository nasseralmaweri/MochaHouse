// SC3a — the CENTERIVO SaaS subscription-billing provider boundary.
//
// Deliberately SEPARATE from the restaurant payment boundary
// (PaymentProvider / PAYMENT_PROVIDER): its own interface, injection token,
// configuration and secrets, and no shared code (the separation guard spec
// enforces this). SaaS billing charges a business for CENTERIVO; restaurant
// payments charge a business's customers. They never meet.
//
// Only what the billing lifecycle needs. A provider never decides
// entitlements: it reports facts (verified events) and performs requested
// operations with the caller's idempotency key.

export const SAAS_BILLING_PROVIDER = Symbol('SAAS_BILLING_PROVIDER');

// What a verified provider event means for the lifecycle (provider-neutral).
export type ProviderLifecycleEvent =
  | { kind: 'PAYMENT_AUTHORIZED' }
  | {
      kind: 'PAYMENT_SUCCEEDED';
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
  // A type the lifecycle does not act on: recorded and ignored.
  | { kind: 'UNSUPPORTED' };

export interface VerifiedBillingProviderEvent {
  provider: string;
  externalEventId: string;
  // The provider's own event type (recorded for audit).
  providerType: string;
  livemode: boolean;
  occurredAt: Date;
  // SHA-256 of the event content that identifies it. A provider whose
  // redeliveries legitimately vary some fields (e.g. delivery counters)
  // must digest only the stable content (SC3b). The payload itself is not
  // stored.
  payloadDigest: string;
  externalSubscriptionId: string | null;
  externalCustomerId: string | null;
  // A business id found in the event's metadata. NEVER used to find the
  // business — only cross-checked against the business matched through our
  // own stored provider ids; a mismatch rejects the event.
  claimedTenantId: string | null;
  event: ProviderLifecycleEvent;
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

export interface SaasBillingProvider {
  readonly name: string;
  readonly livemode: boolean;
  readonly available: boolean;

  createCustomer(input: {
    idempotencyKey: string;
    tenantId: string;
    businessName: string;
    billingEmail: string;
  }): Promise<{ externalCustomerId: string }>;

  // `chargeAutomatically` must only be true when the business has
  // authorized recurring payment (the lifecycle's mayChargeAutomatically).
  createSubscription(input: {
    idempotencyKey: string;
    tenantId: string;
    externalCustomerId: string;
    externalPriceId: string;
    trialDays: number;
    chargeAutomatically: boolean;
  }): Promise<{ externalSubscriptionId: string }>;

  scheduleCancellation(input: {
    idempotencyKey: string;
    externalSubscriptionId: string;
  }): Promise<void>;

  undoCancellation(input: {
    idempotencyKey: string;
    externalSubscriptionId: string;
  }): Promise<void>;

  // Verifies an incoming event's signature and freshness and normalizes it.
  // Throws BillingEventVerificationError for anything unverifiable.
  verifyEvent(input: {
    rawBody: string;
    signatureHeader: string | undefined;
    now?: Date;
  }): VerifiedBillingProviderEvent;
}

// Bound when no SaaS billing provider is configured: every operation is
// refused and no event verifies.
export class DisabledSaasBillingProvider implements SaasBillingProvider {
  readonly name = 'disabled';
  readonly livemode = false;
  readonly available = false;

  createCustomer(): Promise<{ externalCustomerId: string }> {
    return Promise.reject(new SaasBillingUnavailableError());
  }
  createSubscription(): Promise<{ externalSubscriptionId: string }> {
    return Promise.reject(new SaasBillingUnavailableError());
  }
  scheduleCancellation(): Promise<void> {
    return Promise.reject(new SaasBillingUnavailableError());
  }
  undoCancellation(): Promise<void> {
    return Promise.reject(new SaasBillingUnavailableError());
  }
  verifyEvent(): VerifiedBillingProviderEvent {
    throw new BillingEventVerificationError('SaaS billing is not configured.');
  }
}
