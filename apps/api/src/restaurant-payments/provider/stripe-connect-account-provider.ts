import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import {
  ConnectEventVerificationError,
  ConnectProviderError,
  type ConnectAccountProvider,
  type ConnectAccountSnapshot,
  type VerifiedConnectEvent,
} from './connect-account-provider';

// ESP-04 M1 — Stripe Connect connected accounts through Accounts v2 (the
// current API for new Connect platforms; GA in API version 2026-08-26.dahlia,
// the version this SDK pins — the same one SaaS billing uses). TEST MODE ONLY:
// a live key is refused before this is constructed, and every account or
// event read back must be test mode.
//
// The account is the RESTAURANT's:
//   * dashboard 'full'                — the restaurant controls its account;
//   * defaults.responsibilities:
//       fees_collector  'stripe'      — Stripe collects processing fees from
//                                       the restaurant's account;
//       losses_collector 'stripe'     — Stripe covers negative balances it
//                                       cannot recover (not CENTERIVO);
//   * configuration.merchant with the card_payments capability requested —
//     Stripe's hosted onboarding collects whatever Stripe requires.
// These are what we ASK for; whether the account really has them is read back
// (retrieveAccount) and checked before an account can ever count as ready.

export const STRIPE_CONNECT_API_VERSION = '2026-08-26.dahlia' as const;
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]{1,100}$/;

export interface StripeConnectConfig {
  webhookSecret: string;
}

export class StripeConnectAccountProvider implements ConnectAccountProvider {
  readonly name = 'stripe';
  readonly available = true;
  readonly livemode = false;

  constructor(
    private readonly stripe: Stripe,
    private readonly config: StripeConnectConfig,
  ) {}

  static create(
    secretKey: string,
    config: StripeConnectConfig,
  ): StripeConnectAccountProvider {
    return new StripeConnectAccountProvider(
      new Stripe(secretKey, {
        apiVersion: STRIPE_CONNECT_API_VERSION,
        maxNetworkRetries: 2,
        timeout: 20_000,
        telemetry: false,
        appInfo: { name: 'CENTERIVO restaurant payments' },
      }),
      config,
    );
  }

  async createAccount(input: {
    idempotencyKey: string;
    tenantId: string;
    displayName: string;
    contactEmail: string | null;
    country: string;
  }): Promise<{ accountId: string }> {
    let account: Stripe.V2.Core.Account;
    try {
      account = await this.stripe.v2.core.accounts.create(
        {
          display_name: input.displayName.slice(0, 100),
          ...(input.contactEmail ? { contact_email: input.contactEmail } : {}),
          identity: { country: input.country },
          dashboard: 'full',
          defaults: {
            responsibilities: {
              fees_collector: 'stripe',
              losses_collector: 'stripe',
            },
          },
          configuration: {
            merchant: {
              capabilities: { card_payments: { requested: true } },
            },
          },
          // Ours, for reconciliation only: never trusted to find a business.
          metadata: { centerivo_tenant_id: input.tenantId },
        },
        { idempotencyKey: input.idempotencyKey },
      );
    } catch {
      throw new ConnectProviderError('account_create_failed');
    }
    this.assertTestMode(account.livemode);
    if (!ACCOUNT_ID.test(account.id)) {
      throw new ConnectProviderError('account_id_invalid');
    }
    return { accountId: account.id };
  }

  async createOnboardingLink(input: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    let link: Stripe.V2.Core.AccountLink;
    try {
      link = await this.stripe.v2.core.accountLinks.create({
        account: input.accountId,
        use_case: {
          type: 'account_onboarding',
          account_onboarding: {
            configurations: ['merchant'],
            refresh_url: input.refreshUrl,
            return_url: input.returnUrl,
          },
        },
      });
    } catch {
      throw new ConnectProviderError('account_link_failed');
    }
    this.assertTestMode(link.livemode);
    if (typeof link.url !== 'string') {
      throw new ConnectProviderError('account_link_invalid');
    }
    return { url: link.url };
  }

  async retrieveAccount(accountId: string): Promise<ConnectAccountSnapshot> {
    if (!ACCOUNT_ID.test(accountId)) {
      throw new ConnectProviderError('account_id_invalid');
    }
    let account: Stripe.V2.Core.Account;
    try {
      account = await this.stripe.v2.core.accounts.retrieve(accountId, {
        include: ['configuration.merchant', 'defaults', 'requirements'],
      });
    } catch {
      throw new ConnectProviderError('account_retrieve_failed');
    }
    this.assertTestMode(account.livemode);
    if (account.id !== accountId) {
      throw new ConnectProviderError('account_mismatch');
    }
    return snapshotOf(account);
  }

  verifyEvent(input: {
    rawBody: Buffer;
    signatureHeader: string | undefined;
  }): VerifiedConnectEvent {
    if (
      typeof input.signatureHeader !== 'string' ||
      input.signatureHeader.length > 2000 ||
      input.rawBody.length === 0 ||
      input.rawBody.length > 262_144
    ) {
      throw new ConnectEventVerificationError('Missing signature.');
    }
    try {
      // The ORIGINAL raw bytes: a re-serialized body would not verify. The
      // same signature scheme covers classic (snapshot) and v2 (thin)
      // events.
      // (constructEvent refuses v2 thin events, so the SDK's own header
      // verification is called directly; it is always present at runtime.)
      const signature = this.stripe.webhooks.signature;
      if (!signature) throw new Error('no signature helper');
      signature.verifyHeader(
        input.rawBody,
        input.signatureHeader,
        this.config.webhookSecret,
        STRIPE_SIGNATURE_TOLERANCE_SECONDS,
      );
    } catch {
      throw new ConnectEventVerificationError('Invalid signature.');
    }
    return parseVerifiedEvent(input.rawBody, 'stripe');
  }

  private assertTestMode(livemode: unknown): void {
    if (livemode !== false) {
      throw new ConnectProviderError('live_mode_refused');
    }
  }
}

// The account fields we keep, exactly as Stripe reported them.
export function snapshotOf(
  account: Stripe.V2.Core.Account,
): ConnectAccountSnapshot {
  const responsibilities = account.defaults?.responsibilities;
  const card = account.configuration?.merchant?.capabilities?.card_payments;
  const entries = account.requirements?.entries ?? [];
  return {
    accountId: account.id,
    livemode: account.livemode,
    closed: account.closed === true,
    dashboard: account.dashboard ?? null,
    feesCollector: responsibilities?.fees_collector ?? null,
    lossesCollector: responsibilities?.losses_collector ?? null,
    cardPaymentsStatus: card?.status ?? null,
    requirementsStatus:
      account.requirements?.summary?.minimum_deadline?.status ?? null,
    requirementsDue: entries.filter((e) => e.awaiting_action_from === 'user')
      .length,
  };
}

// The event's identity and the account it names, from a VERIFIED raw body.
// Classic events ("object": "event", e.g. account.updated) carry the
// connected account in `account` (Connect) or as the account object itself;
// v2 thin events ("object": "v2.core.event", e.g. v2.core.account.updated)
// name it as `related_object`. The body is never trusted for anything else.
export function parseVerifiedEvent(
  rawBody: Buffer,
  provider: string,
): VerifiedConnectEvent {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('not an object');
    }
    body = parsed as Record<string, unknown>;
  } catch {
    throw new ConnectEventVerificationError('Unreadable event.');
  }
  const id = text(body.id, 255);
  const type = text(body.type, 120);
  if (!id || !type || typeof body.livemode !== 'boolean') {
    throw new ConnectEventVerificationError('Incomplete event.');
  }
  return {
    provider,
    externalEventId: id,
    type,
    livemode: body.livemode,
    externalAccountId: accountIdOf(body),
    payloadDigest: createHash('sha256').update(rawBody).digest('hex'),
  };
}

function accountIdOf(body: Record<string, unknown>): string | null {
  const candidates: unknown[] = [];
  if (body.object === 'v2.core.event') {
    const related = record(body.related_object);
    if (related && related.type === 'v2.core.account') {
      candidates.push(related.id);
    }
    // Events from a connected account carry its id as `context`.
    candidates.push(body.context);
  } else {
    candidates.push(body.account);
    const object = record(record(body.data)?.object);
    if (object && object.object === 'account') candidates.push(object.id);
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && ACCOUNT_ID.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : null;
}
