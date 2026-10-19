// ESP-04 M1 — the boundary to the restaurant-payments provider for CONNECTED
// ACCOUNTS (Stripe Connect, Accounts v2). Restaurant customer payments only:
// it shares no configuration, credential, webhook or code with CENTERIVO's
// own SaaS billing provider.
//
// It only ever creates an account, opens the provider's hosted onboarding for
// it, reads the account back, and verifies webhook signatures. It never moves
// money. Everything we store about an account comes from retrieveAccount —
// never from a redirect or an event body.

export const CONNECT_ACCOUNT_PROVIDER = Symbol('CONNECT_ACCOUNT_PROVIDER');

// What the provider reports about a connected account.
export interface ConnectAccountSnapshot {
  accountId: string;
  livemode: boolean;
  closed: boolean;
  // Stripe dashboard access: 'full' | 'express' | 'none' (or null).
  dashboard: string | null;
  // Who collects the account's processing fees and who covers its negative
  // balances, as configured on the account.
  feesCollector: string | null;
  lossesCollector: string | null;
  // The merchant configuration's card-payments capability: 'active' |
  // 'pending' | 'restricted' | 'unsupported' (null when not requested).
  cardPaymentsStatus: string | null;
  // The soonest outstanding requirement: 'currently_due' | 'eventually_due' |
  // 'past_due' (null when nothing is outstanding).
  requirementsStatus: string | null;
  // Requirements waiting for the restaurant (not for Stripe).
  requirementsDue: number;
}

// A webhook event whose signature verified. Only what is needed to find the
// account; the account's state is then read back from the provider.
export interface VerifiedConnectEvent {
  provider: string;
  externalEventId: string;
  type: string;
  livemode: boolean;
  // The connected account the event is about (null when it names none).
  externalAccountId: string | null;
  // SHA-256 (hex) of the raw body.
  payloadDigest: string;
}

export class ConnectEventVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectEventVerificationError';
  }
}

// The provider refused or could not be reached. `code` is a fixed value,
// never provider text.
export class ConnectProviderError extends Error {
  constructor(readonly code: string) {
    super(`Restaurant payments provider error (${code}).`);
    this.name = 'ConnectProviderError';
  }
}

export interface ConnectAccountProvider {
  readonly name: string;
  // False when no restaurant-payments provider is configured.
  readonly available: boolean;
  // Test mode only in this milestone.
  readonly livemode: false;
  // Creates the restaurant's account. `idempotencyKey` is derived from OUR
  // record, so a retry (or a concurrent request) gets the same account back
  // instead of a second one.
  createAccount(input: {
    idempotencyKey: string;
    tenantId: string;
    displayName: string;
    contactEmail: string | null;
    country: string;
  }): Promise<{ accountId: string }>;
  // The provider's hosted onboarding page for the account (single use).
  createOnboardingLink(input: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  retrieveAccount(accountId: string): Promise<ConnectAccountSnapshot>;
  verifyEvent(input: {
    rawBody: Buffer;
    signatureHeader: string | undefined;
  }): VerifiedConnectEvent;
}

// Bound when no restaurant-payments provider is configured (the default).
export class DisabledConnectAccountProvider implements ConnectAccountProvider {
  readonly name = 'disabled';
  readonly available = false;
  readonly livemode = false;

  createAccount(): Promise<{ accountId: string }> {
    return Promise.reject(new ConnectProviderError('disabled'));
  }

  createOnboardingLink(): Promise<{ url: string }> {
    return Promise.reject(new ConnectProviderError('disabled'));
  }

  retrieveAccount(): Promise<ConnectAccountSnapshot> {
    return Promise.reject(new ConnectProviderError('disabled'));
  }

  verifyEvent(): VerifiedConnectEvent {
    throw new ConnectEventVerificationError('No provider is configured.');
  }
}
