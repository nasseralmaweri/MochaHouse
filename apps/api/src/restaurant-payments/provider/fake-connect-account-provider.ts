import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  ConnectEventVerificationError,
  ConnectProviderError,
  type ConnectAccountProvider,
  type ConnectAccountSnapshot,
  type VerifiedConnectEvent,
} from './connect-account-provider';
import { parseVerifiedEvent } from './stripe-connect-account-provider';

// ESP-04 M1 — a deterministic in-memory stand-in for Stripe Connect accounts:
// development and tests ONLY (refused in production, staging or live
// environments by the mode resolver). No network, no money. Accounts are
// created idempotently (the same idempotency key always returns the same
// account), start as Stripe's would after creation (card payments pending,
// requirements due), and tests move them through Stripe's states with
// `setAccount`. Events are signed like Stripe's ("t=…,v1=<HMAC-SHA256 of
// `${t}.${rawBody}`>") with the configured secret.

const TOLERANCE_SECONDS = 300;

export class FakeConnectAccountProvider implements ConnectAccountProvider {
  readonly name = 'fake';
  readonly available = true;
  readonly livemode = false;

  private readonly accounts = new Map<string, ConnectAccountSnapshot>();
  private readonly byIdempotencyKey = new Map<string, string>();
  createCalls = 0;
  // Set to make the next provider calls fail (tests).
  failNext: 'create' | 'link' | 'retrieve' | null = null;

  constructor(private readonly webhookSecret: string) {}

  createAccount(input: {
    idempotencyKey: string;
    tenantId: string;
  }): Promise<{ accountId: string }> {
    this.createCalls += 1;
    if (this.failNext === 'create') {
      this.failNext = null;
      return Promise.reject(new ConnectProviderError('account_create_failed'));
    }
    const existing = this.byIdempotencyKey.get(input.idempotencyKey);
    if (existing) return Promise.resolve({ accountId: existing });
    const accountId = `acct_fake${createHash('sha256')
      .update(input.idempotencyKey)
      .digest('hex')
      .slice(0, 16)}`;
    this.byIdempotencyKey.set(input.idempotencyKey, accountId);
    this.accounts.set(accountId, {
      accountId,
      livemode: false,
      closed: false,
      dashboard: 'full',
      feesCollector: 'stripe',
      lossesCollector: 'stripe',
      cardPaymentsStatus: 'pending',
      requirementsStatus: 'currently_due',
      requirementsDue: 3,
    });
    return Promise.resolve({ accountId });
  }

  createOnboardingLink(input: { accountId: string }): Promise<{ url: string }> {
    if (this.failNext === 'link') {
      this.failNext = null;
      return Promise.reject(new ConnectProviderError('account_link_failed'));
    }
    if (!this.accounts.has(input.accountId)) {
      return Promise.reject(new ConnectProviderError('account_not_found'));
    }
    return Promise.resolve({
      url: `https://connect.fake.test/onboarding/${input.accountId}`,
    });
  }

  retrieveAccount(accountId: string): Promise<ConnectAccountSnapshot> {
    if (this.failNext === 'retrieve') {
      this.failNext = null;
      return Promise.reject(
        new ConnectProviderError('account_retrieve_failed'),
      );
    }
    const account = this.accounts.get(accountId);
    if (!account) {
      return Promise.reject(new ConnectProviderError('account_not_found'));
    }
    return Promise.resolve({ ...account });
  }

  // Tests: what Stripe would now report for the account.
  setAccount(accountId: string, change: Partial<ConnectAccountSnapshot>): void {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`Unknown fake account ${accountId}`);
    this.accounts.set(accountId, { ...account, ...change, accountId });
  }

  // Tests: an account created directly at the provider (not through us).
  addAccount(snapshot: ConnectAccountSnapshot): void {
    this.accounts.set(snapshot.accountId, { ...snapshot });
  }

  verifyEvent(input: {
    rawBody: Buffer;
    signatureHeader: string | undefined;
  }): VerifiedConnectEvent {
    const header = parseHeader(input.signatureHeader);
    if (
      !header ||
      input.rawBody.length === 0 ||
      input.rawBody.length > 262_144
    ) {
      throw new ConnectEventVerificationError('Missing signature.');
    }
    if (Math.abs(Date.now() / 1000 - header.timestamp) > TOLERANCE_SECONDS) {
      throw new ConnectEventVerificationError('Stale signature.');
    }
    const expected = Buffer.from(
      sign(this.webhookSecret, header.timestamp, input.rawBody),
      'hex',
    );
    const given = Buffer.from(header.signature, 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new ConnectEventVerificationError('Invalid signature.');
    }
    return parseVerifiedEvent(input.rawBody, 'fake');
  }

  // Tests: a signed delivery of `body`.
  signedEvent(
    body: Record<string, unknown>,
    timestamp = Math.floor(Date.now() / 1000),
  ): { rawBody: Buffer; signatureHeader: string } {
    const rawBody = Buffer.from(JSON.stringify(body));
    return {
      rawBody,
      signatureHeader: `t=${timestamp},v1=${sign(this.webhookSecret, timestamp, rawBody)}`,
    };
  }
}

function sign(secret: string, timestamp: number, rawBody: Buffer): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
}

function parseHeader(
  value: string | undefined,
): { timestamp: number; signature: string } | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  const parts = Object.fromEntries(
    value.split(',').map((part) => {
      const at = part.indexOf('=');
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
    }),
  );
  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/.test(signature ?? '')) {
    return null;
  }
  return { timestamp, signature };
}
