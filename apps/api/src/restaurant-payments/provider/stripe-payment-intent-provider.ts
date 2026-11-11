import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import type {
  ChargeResult,
  CreatePaymentIntentRequest,
  PaymentAccountContext,
  PaymentIntentProvider,
  PaymentIntentResult,
  PaymentProvider,
} from '@mocha-house/integrations';

// ESP-04 M3 — restaurant customer payments through Stripe PaymentIntents, as
// DIRECT CHARGES on the restaurant's own connected account (ESP-04 M1): the
// intent lives on that account (the Stripe-Account header), the restaurant
// pays Stripe's fees, and CENTERIVO takes no application fee (A2). TEST MODE
// ONLY: a live key is refused before this is constructed, and every intent
// read back must be test mode. Cards only (B4).
//
// Payment safety (safeguard 1). The ONLY definitive "nothing can be charged"
// answer this adapter gives at creation is a LOCAL refusal: a request that is
// refused before anything is sent to Stripe (no connected account, a
// currency or amount it may not take). ANY answer from Stripe that is not a
// PaymentIntent — a 4xx of any kind, an idempotency conflict, a rate limit, a
// 5xx, a timeout, a connection error — is "unknown": the request may have
// been processed (an SDK retry, a key replay, a race), so the payment stays
// held, never released. A malformed, live-mode or mismatched answer is
// "unknown" too. Only reading an intent back moves a payment on.
//
// Shares no credential with CENTERIVO's SaaS billing (startup validation,
// payment-provider-mode.ts). Client secrets are returned to the caller only
// when the browser needs one, and never logged.

export const STRIPE_PAYMENTS_API_VERSION = '2026-08-26.dahlia' as const;
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]{1,100}$/;
const INTENT_ID = /^pi_[A-Za-z0-9]{1,100}$/;
const EVENT_ID = /^evt_[A-Za-z0-9]{1,100}$/;

// M3 takes US dollars only (the connected accounts are US, M1
// PAYMENTS_CONNECT_COUNTRY), at least Stripe's minimum charge.
export const STRIPE_SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set([
  'USD',
]);
export const STRIPE_MINIMUM_CHARGE_MINOR_UNITS = 50;

// The payment events this integration acts on (B1: delivered to their own
// endpoint). Classic snapshot events about payment intents on connected
// accounts.
export const PAYMENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'payment_intent.succeeded',
  'payment_intent.processing',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'payment_intent.requires_action',
]);

// Metadata keys we put on an intent: our ids only, never personal data.
const METADATA_KEYS: ReadonlySet<string> = new Set([
  'centerivo_tenant_id',
  'centerivo_payment_attempt_id',
]);

export interface StripePaymentsConfig {
  // pk_test_… — the platform's publishable key; the browser initialises
  // Stripe.js with it and the connected account (direct charges).
  publishableKey: string;
  // whsec_… of the payment-events endpoint (B1), never the M1 or billing one.
  paymentsWebhookSecret: string;
  // B2 — the businesses allowed to take test payments; empty means none.
  allowedTenantIds: ReadonlySet<string>;
}

// A verified payment webhook event: what is needed to find the payment. The
// payment's state is always read back from Stripe, never taken from the
// event.
export interface VerifiedPaymentEvent {
  provider: 'stripe';
  externalEventId: string;
  type: string;
  livemode: boolean;
  // The connected account the event happened on (the event's `account`).
  externalAccountId: string | null;
  // The payment intent it is about (data.object.id), null when none.
  externalObjectId: string | null;
  // Whether the intent says it was created by CENTERIVO (our metadata key).
  // Untrusted — a filter for what is worth keeping, never used to link.
  claimsCenterivo: boolean;
  payloadDigest: string;
}

export class PaymentEventVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentEventVerificationError';
  }
}

export class StripePaymentIntentProvider
  implements PaymentIntentProvider, PaymentProvider
{
  readonly name = 'stripe';
  readonly acceptsPayments = true;
  // Gift-card purchases keep the one-step charge until ESP-04 M6.
  readonly acceptsOneStepCharges = false;
  readonly livemode = false;

  constructor(
    private readonly stripe: Stripe,
    private readonly config: StripePaymentsConfig,
  ) {}

  static create(
    secretKey: string,
    config: StripePaymentsConfig,
  ): StripePaymentIntentProvider {
    return new StripePaymentIntentProvider(
      new Stripe(secretKey, {
        apiVersion: STRIPE_PAYMENTS_API_VERSION,
        // The SDK retries with the SAME idempotency key (ours).
        maxNetworkRetries: 2,
        timeout: 20_000,
        telemetry: false,
        appInfo: { name: 'CENTERIVO restaurant payments' },
      }),
      config,
    );
  }

  get publishableKey(): string {
    return this.config.publishableKey;
  }

  // B2 — the test-mode allowlist.
  allowsTenant(tenantId: string): boolean {
    return this.config.allowedTenantIds.has(tenantId);
  }

  // Never called by checkout (two steps); refused without contacting Stripe,
  // so nothing can have been charged.
  charge(): Promise<ChargeResult> {
    return Promise.resolve({
      outcome: 'failed',
      reason: 'One-step charges are not available with Stripe payments.',
    });
  }

  async createPaymentIntent(
    request: CreatePaymentIntentRequest,
  ): Promise<PaymentIntentResult> {
    // LOCAL refusals: nothing is sent, so no intent can exist.
    const account = request.account.connectedAccountId;
    if (account === null || !ACCOUNT_ID.test(account)) {
      return { status: 'failed', reason: 'stripe_local:no_connected_account' };
    }
    const currency = request.currency.toUpperCase();
    if (!STRIPE_SUPPORTED_CURRENCIES.has(currency)) {
      return { status: 'failed', reason: 'stripe_local:currency_unsupported' };
    }
    if (
      !Number.isInteger(request.amount) ||
      request.amount < STRIPE_MINIMUM_CHARGE_MINOR_UNITS
    ) {
      return { status: 'failed', reason: 'stripe_local:amount_invalid' };
    }
    if (!this.allowsTenant(request.account.tenantId)) {
      return { status: 'failed', reason: 'stripe_local:tenant_not_enabled' };
    }

    let intent: Stripe.PaymentIntent;
    try {
      intent = await this.stripe.paymentIntents.create(
        {
          amount: request.amount,
          currency: currency.toLowerCase(),
          payment_method_types: ['card'],
          capture_method: 'automatic',
          metadata: {
            ...safeMetadata(request.metadata),
            centerivo_tenant_id: request.account.tenantId,
          },
        },
        { stripeAccount: account, idempotencyKey: request.idempotencyKey },
      );
    } catch (error) {
      // Safeguard 1 — whatever Stripe answered, it may have processed the
      // request: held, with a fixed code for support.
      return { status: 'unknown', reason: `stripe_create:${errorCode(error)}` };
    }
    const reference =
      typeof intent?.id === 'string' && INTENT_ID.test(intent.id)
        ? intent.id
        : undefined;
    if (
      !reference ||
      intent.livemode !== false ||
      intent.amount !== request.amount ||
      typeof intent.currency !== 'string' ||
      intent.currency.toUpperCase() !== currency
    ) {
      return {
        status: 'unknown',
        reason: 'stripe_create:unexpected_answer',
        ...(reference ? { reference } : {}),
      };
    }
    return resultOf(intent);
  }

  async retrievePaymentIntent(input: {
    reference: string;
    account: PaymentAccountContext;
  }): Promise<PaymentIntentResult> {
    const intent = await this.retrieve(input);
    if (intent === null) {
      return { status: 'unknown', reason: 'stripe_retrieve:failed' };
    }
    return resultOf(intent);
  }

  async clientSecretFor(input: {
    reference: string;
    account: PaymentAccountContext;
  }): Promise<string | null> {
    const intent = await this.retrieve(input);
    if (intent === null || typeof intent.client_secret !== 'string') {
      // The caller answers "try again in a moment"; nothing changes.
      throw new Error('stripe_client_secret:unavailable');
    }
    return intent.client_secret;
  }

  // ESP-04 M4 cancels abandoned intents. Nothing in M3 cancels: refused
  // without contacting Stripe.
  cancelPaymentIntent(input: {
    reference: string;
  }): Promise<PaymentIntentResult> {
    return Promise.resolve({
      status: 'unknown',
      reason: 'stripe_cancel:not_available',
      reference: input.reference,
    });
  }

  // Verifies a payment-events webhook (B1: its own signing secret) over the
  // ORIGINAL raw body. Classic snapshot events only.
  verifyPaymentEvent(input: {
    rawBody: Buffer;
    signatureHeader: string | undefined;
  }): VerifiedPaymentEvent {
    if (
      typeof input.signatureHeader !== 'string' ||
      input.signatureHeader.length > 2000 ||
      input.rawBody.length === 0 ||
      input.rawBody.length > 262_144
    ) {
      throw new PaymentEventVerificationError('Missing signature.');
    }
    try {
      const signature = this.stripe.webhooks.signature;
      if (!signature) throw new Error('no signature helper');
      signature.verifyHeader(
        input.rawBody,
        input.signatureHeader,
        this.config.paymentsWebhookSecret,
        STRIPE_SIGNATURE_TOLERANCE_SECONDS,
      );
    } catch {
      throw new PaymentEventVerificationError('Invalid signature.');
    }
    return parseVerifiedPaymentEvent(input.rawBody);
  }

  // The intent as Stripe holds it on THIS account, or null when it cannot be
  // read (any error, another account's, a live one, a different intent).
  private async retrieve(input: {
    reference: string;
    account: PaymentAccountContext;
  }): Promise<Stripe.PaymentIntent | null> {
    const account = input.account.connectedAccountId;
    if (
      !INTENT_ID.test(input.reference) ||
      account === null ||
      !ACCOUNT_ID.test(account)
    ) {
      return null;
    }
    let intent: Stripe.PaymentIntent;
    try {
      intent = await this.stripe.paymentIntents.retrieve(
        input.reference,
        {},
        { stripeAccount: account },
      );
    } catch {
      return null;
    }
    if (intent?.id !== input.reference || intent.livemode !== false) {
      return null;
    }
    return intent;
  }
}

// What a PaymentIntent's state means for the payment (M2 vocabulary).
export function resultOf(intent: Stripe.PaymentIntent): PaymentIntentResult {
  const reference = intent.id;
  if (intent.livemode !== false) {
    return { status: 'unknown', reason: 'stripe:live_mode_refused', reference };
  }
  // Money received on an intent that is not succeeded (waiting, refused,
  // processing or cancelled) is never a state this payment can be moved on
  // from: held for people.
  if (intent.status !== 'succeeded' && intent.amount_received !== 0) {
    return { status: 'unknown', reason: 'stripe:amount_received', reference };
  }
  // ESP-04 M4a — what the intent is FOR, reported with every state that is
  // not final, so recovery can refuse an intent for another amount.
  const target = {
    amount: intent.amount,
    currency: String(intent.currency).toUpperCase(),
  };
  switch (intent.status) {
    case 'succeeded':
      return {
        status: 'succeeded',
        reference,
        // What Stripe actually took: compared with the frozen checkout.
        amount: intent.amount_received,
        currency: String(intent.currency).toUpperCase(),
      };
    case 'requires_payment_method':
      // A new intent waits for its card; one with a refused attempt may be
      // tried again on the same intent.
      return intent.last_payment_error
        ? { status: 'requires_payment_method', reference, ...target }
        : { status: 'requires_customer_action', reference, ...target };
    case 'requires_confirmation':
    case 'requires_action':
      return { status: 'requires_customer_action', reference, ...target };
    case 'processing':
      return { status: 'processing', reference, ...target };
    case 'canceled':
      // Cancelled with nothing taken (checked above): no charge can occur.
      return { status: 'canceled', reference };
    default:
      // requires_capture (never asked for) or anything new: not definitive.
      return {
        status: 'unknown',
        reason: 'stripe:unexpected_status',
        reference,
      };
  }
}

// The event's identity, account and intent from a VERIFIED raw body. The body
// is never trusted for anything else.
export function parseVerifiedPaymentEvent(
  rawBody: Buffer,
): VerifiedPaymentEvent {
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
    throw new PaymentEventVerificationError('Unreadable event.');
  }
  const id =
    typeof body.id === 'string' && EVENT_ID.test(body.id) ? body.id : null;
  const type =
    typeof body.type === 'string' && body.type.length <= 120 ? body.type : null;
  if (!id || !type || typeof body.livemode !== 'boolean') {
    throw new PaymentEventVerificationError('Incomplete event.');
  }
  const object = record(record(body.data)?.object);
  const intentId =
    object?.object === 'payment_intent' &&
    typeof object.id === 'string' &&
    INTENT_ID.test(object.id)
      ? object.id
      : null;
  const metadata = record(object?.metadata);
  return {
    provider: 'stripe',
    externalEventId: id,
    type,
    livemode: body.livemode,
    externalAccountId:
      typeof body.account === 'string' && ACCOUNT_ID.test(body.account)
        ? body.account
        : null,
    externalObjectId: intentId,
    claimsCenterivo: typeof metadata?.centerivo_payment_attempt_id === 'string',
    payloadDigest: createHash('sha256').update(rawBody).digest('hex'),
  };
}

function safeMetadata(
  metadata: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (metadata?.paymentAttemptId) {
    out.centerivo_payment_attempt_id = metadata.paymentAttemptId.slice(0, 100);
  }
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (METADATA_KEYS.has(key) && typeof value === 'string') {
      out[key] = value.slice(0, 100);
    }
  }
  return out;
}

// ESP-04 M4a — whether an "unknown" creation answer is Stripe refusing the
// idempotency key because it was used with OTHER parameters: retrying the
// same request can never help (people must look). A concurrent request
// with the same key (idempotency_key_in_use) is NOT this: retry later.
export function isIdempotencyMismatch(reason: string): boolean {
  return (
    reason.startsWith('stripe_create:StripeIdempotencyError') &&
    !reason.includes('idempotency_key_in_use')
  );
}

// A fixed, provider-text-free code for support: the error class and Stripe's
// error code, both restricted to a safe alphabet.
function errorCode(error: unknown): string {
  const safe = (value: unknown) =>
    typeof value === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(value)
      ? value
      : null;
  if (error && typeof error === 'object') {
    const e = error as { type?: unknown; code?: unknown };
    const type = safe(e.type) ?? 'error';
    const code = safe(e.code);
    return code ? `${type}:${code}` : type;
  }
  return 'error';
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
