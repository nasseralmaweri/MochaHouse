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
import type { StripeRefundState } from '../../payment/payment-refunds';

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

// ESP-04 M4b — see StripePaymentIntentProvider.abandonmentFactsFor.
export interface AbandonmentFacts {
  status: string;
  amount: number;
  currency: string;
  amountReceived: number;
  nextActionPending: boolean;
  // 'none' (no charge attempted), a Stripe charge status ('failed',
  // 'pending', 'succeeded'), or 'unknown'.
  latestCharge: string;
}

// --- ESP-04 M5a — refunds -------------------------------------------------
const REFUND_ID = /^re_[A-Za-z0-9]{1,100}$/;
// Our own ids (uuid) as sent in a refund's metadata.
const OUR_ID = /^[A-Za-z0-9-]{1,100}$/;
const REFUND_LIST_PAGE_SIZE = 100;
const REFUND_LIST_MAX_PAGES = 10;

// The reasons CENTERIVO sends. `fraudulent` is deliberately not one: it is
// not a staff decision in V1.
export type StripeRefundReason = 'requested_by_customer' | 'duplicate';
const STRIPE_REFUND_REASONS: ReadonlySet<string> = new Set([
  'requested_by_customer',
  'duplicate',
]);

// What the payment says before a refund of it is asked for.
export interface RefundPaymentFacts {
  status: string;
  amount: number;
  amountReceived: number;
  currency: string;
  // What Stripe has refunded of the latest charge (CENTERIVO's and the
  // Dashboard's together); null when not known.
  chargeAmountRefunded: number | null;
  chargeDisputed: boolean | null;
}

// One refund as Stripe reports it — only ever a refund of the intent asked
// about.
export interface RefundObservation {
  providerRefundId: string;
  state: StripeRefundState;
  amountMinorUnits: number;
  currency: string;
  // Our PaymentRefund id when CENTERIVO made it; null for a refund made
  // elsewhere (the Dashboard). Matched only within a read-back of the
  // payment's own refunds on its own account, never from a webhook body.
  centerivoRefundId: string | null;
  // Stripe's failure reason code, when failed or canceled.
  failureReason: string | null;
}

export type RefundRequestOutcome =
  | { kind: 'observed'; refund: RefundObservation }
  // Nothing was sent to Stripe: definitively no refund.
  | { kind: 'refused_locally' }
  // Anything else: the refund may exist. Only a read-back settles it.
  | { kind: 'unknown'; reason: string };

const REFUND_STATES: ReadonlySet<string> = new Set([
  'pending',
  'requires_action',
  'succeeded',
  'failed',
  'canceled',
]);

// ESP-04 M5b — whether createRefund would refuse this request without
// sending anything (the same pure check it uses), so a caller can know
// BEFORE recording that it was sent.
export function refundRequestRefusedLocally(input: {
  reference: string;
  account: PaymentAccountContext;
  amountMinorUnits: number;
  currency: string;
  reason: string;
  refundId: string;
  tenantId: string;
  idempotencyKey: string;
}): boolean {
  const account = input.account.connectedAccountId;
  return (
    !INTENT_ID.test(input.reference) ||
    account === null ||
    !ACCOUNT_ID.test(account) ||
    !Number.isSafeInteger(input.amountMinorUnits) ||
    input.amountMinorUnits <= 0 ||
    !/^[A-Z]{3}$/.test(input.currency) ||
    !STRIPE_REFUND_REASONS.has(input.reason) ||
    !OUR_ID.test(input.refundId) ||
    !OUR_ID.test(input.tenantId) ||
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.length === 0 ||
    input.idempotencyKey.length > 255
  );
}

// A refund object of THIS intent, in our vocabulary; null when it is not a
// refund, or is another intent's.
export function observeRefund(
  refund: Stripe.Refund | null | undefined,
  reference: string,
): RefundObservation | null {
  if (
    !refund ||
    typeof refund !== 'object' ||
    typeof refund.id !== 'string' ||
    !REFUND_ID.test(refund.id) ||
    !Number.isSafeInteger(refund.amount) ||
    refund.amount <= 0 ||
    typeof refund.currency !== 'string'
  ) {
    return null;
  }
  const intent =
    typeof refund.payment_intent === 'string'
      ? refund.payment_intent
      : (refund.payment_intent?.id ?? null);
  if (intent !== reference) return null;
  const status = String(refund.status);
  const metadataId = refund.metadata?.centerivo_refund_id;
  const failure = refund.failure_reason;
  return {
    providerRefundId: refund.id,
    state: REFUND_STATES.has(status)
      ? (status as StripeRefundState)
      : 'unknown',
    amountMinorUnits: refund.amount,
    currency: refund.currency.toUpperCase(),
    centerivoRefundId:
      typeof metadataId === 'string' && OUR_ID.test(metadataId)
        ? metadataId
        : null,
    failureReason:
      typeof failure === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(failure)
        ? failure
        : failure
          ? 'unknown'
          : null,
  };
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

  // ESP-04 M4b — cancels an ABANDONED intent on the account it lives on
  // (the server's stored account; never a client value), with reason
  // "abandoned" and the caller's stable idempotency key. Whatever Stripe
  // answers is only a hint: the caller ALWAYS reads the intent back, and only
  // that read-back can close the payment. Any error is "unknown".
  async cancelPaymentIntent(input: {
    reference: string;
    account: PaymentAccountContext;
    idempotencyKey?: string;
  }): Promise<PaymentIntentResult> {
    const account = input.account.connectedAccountId;
    if (
      !INTENT_ID.test(input.reference) ||
      account === null ||
      !ACCOUNT_ID.test(account)
    ) {
      return { status: 'unknown', reason: 'stripe_cancel:refused_locally' };
    }
    let intent: Stripe.PaymentIntent;
    try {
      intent = await this.stripe.paymentIntents.cancel(
        input.reference,
        { cancellation_reason: 'abandoned' },
        {
          stripeAccount: account,
          ...(input.idempotencyKey
            ? { idempotencyKey: input.idempotencyKey }
            : {}),
        },
      );
    } catch (error) {
      return {
        status: 'unknown',
        reason: `stripe_cancel:${errorCode(error)}`,
        reference: input.reference,
      };
    }
    if (intent?.id !== input.reference || intent.livemode !== false) {
      return {
        status: 'unknown',
        reason: 'stripe_cancel:unexpected_answer',
        reference: input.reference,
      };
    }
    return resultOf(intent);
  }

  // ESP-04 M4b — what abandoned-payment cleanup must know before it may
  // cancel: the intent's state, what it is for, what it has received,
  // whether an action is pending, and its latest charge's status — read on
  // the stored account. Null when it cannot be read (or is live, or another
  // intent).
  async abandonmentFactsFor(input: {
    reference: string;
    account: PaymentAccountContext;
  }): Promise<AbandonmentFacts | null> {
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
        { expand: ['latest_charge'] },
        { stripeAccount: account },
      );
    } catch {
      return null;
    }
    if (intent?.id !== input.reference || intent.livemode !== false) {
      return null;
    }
    const charge = intent.latest_charge;
    return {
      status: String(intent.status),
      amount: intent.amount,
      currency: String(intent.currency).toUpperCase(),
      amountReceived: intent.amount_received,
      nextActionPending: intent.next_action != null,
      // No charge yet; or the latest charge's status (an unexpanded id
      // proves nothing: reported as unknown).
      latestCharge:
        charge === null || charge === undefined
          ? 'none'
          : typeof charge === 'string'
            ? 'unknown'
            : String(charge.status),
    };
  }

  // --- ESP-04 M5a — refunds (adapter only: nothing in M5a calls these) ------
  //
  // A refund is made on the ORIGINAL payment intent, on the connected account
  // it was made on (a direct charge: the restaurant's balance funds it; no
  // application fee to return, no transfer to reverse). Refund safety mirrors
  // payment safety (safeguard 1): the only definitive "nothing was refunded"
  // answer here is a LOCAL refusal, made before anything is sent. ANY answer
  // from Stripe that is not a refund for this intent — a 4xx of any kind, an
  // idempotency conflict, a rate limit, a 5xx, a timeout — is "unknown": the
  // refund may exist. Only reading refunds back settles anything.
  //
  // The Refund object carries no livemode; test mode is guaranteed by the
  // test-mode key (refused otherwise at startup) and by the intent itself,
  // read back as test mode (refundFactsFor) before any refund is asked for.

  // What a refund needs to know about the payment first: the intent's state
  // and amounts, and its latest charge (what Stripe has refunded of it, and
  // whether it is disputed). Null when it cannot be read, is live, or is
  // another intent.
  async refundFactsFor(input: {
    reference: string;
    account: PaymentAccountContext;
  }): Promise<RefundPaymentFacts | null> {
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
        { expand: ['latest_charge'] },
        { stripeAccount: account },
      );
    } catch {
      return null;
    }
    if (intent?.id !== input.reference || intent.livemode !== false) {
      return null;
    }
    const charge = intent.latest_charge;
    const expanded = charge !== null && typeof charge === 'object';
    return {
      status: String(intent.status),
      amount: intent.amount,
      amountReceived: intent.amount_received,
      currency: String(intent.currency).toUpperCase(),
      // Null when the latest charge was not expanded (proves nothing).
      chargeAmountRefunded: expanded ? charge.amount_refunded : null,
      chargeDisputed: expanded ? charge.disputed : null,
    };
  }

  // Ask Stripe for ONE refund operation, with that operation's own key.
  // Every retry of the operation must send the same key and the same
  // parameters (Stripe refuses a key reused with others).
  async createRefund(input: {
    reference: string;
    account: PaymentAccountContext;
    amountMinorUnits: number;
    currency: string;
    reason: StripeRefundReason;
    // Our PaymentRefund id, and its business: the only metadata sent.
    refundId: string;
    tenantId: string;
    idempotencyKey: string;
  }): Promise<RefundRequestOutcome> {
    const account = input.account.connectedAccountId;
    if (refundRequestRefusedLocally(input) || account === null) {
      // Nothing was sent: definitively no refund.
      return { kind: 'refused_locally' };
    }
    let refund: Stripe.Refund;
    try {
      refund = await this.stripe.refunds.create(
        {
          payment_intent: input.reference,
          amount: input.amountMinorUnits,
          reason: input.reason,
          metadata: {
            centerivo_tenant_id: input.tenantId,
            centerivo_refund_id: input.refundId,
          },
        },
        { stripeAccount: account, idempotencyKey: input.idempotencyKey },
      );
    } catch (error) {
      return { kind: 'unknown', reason: `stripe_refund:${errorCode(error)}` };
    }
    const observed = observeRefund(refund, input.reference);
    if (
      !observed ||
      observed.amountMinorUnits !== input.amountMinorUnits ||
      observed.currency !== input.currency ||
      observed.centerivoRefundId !== input.refundId
    ) {
      return { kind: 'unknown', reason: 'stripe_refund:unexpected_answer' };
    }
    return { kind: 'observed', refund: observed };
  }

  // One refund as Stripe holds it now, on the payment's account. Null when
  // it cannot be read or is not a refund of this intent.
  async retrieveRefund(input: {
    providerRefundId: string;
    reference: string;
    account: PaymentAccountContext;
  }): Promise<RefundObservation | null> {
    const account = input.account.connectedAccountId;
    if (
      !REFUND_ID.test(input.providerRefundId) ||
      !INTENT_ID.test(input.reference) ||
      account === null ||
      !ACCOUNT_ID.test(account)
    ) {
      return null;
    }
    let refund: Stripe.Refund;
    try {
      refund = await this.stripe.refunds.retrieve(
        input.providerRefundId,
        {},
        { stripeAccount: account },
      );
    } catch {
      return null;
    }
    const observed = observeRefund(refund, input.reference);
    return observed?.providerRefundId === input.providerRefundId
      ? observed
      : null;
  }

  // Every refund of this intent, on its account (CENTERIVO's and the
  // Dashboard's), newest first. `complete` is false when there were more
  // than the bounded number of pages read. Null when they cannot be read or
  // the list holds a refund of another intent.
  async listRefundsFor(input: {
    reference: string;
    account: PaymentAccountContext;
  }): Promise<{ refunds: RefundObservation[]; complete: boolean } | null> {
    const account = input.account.connectedAccountId;
    if (
      !INTENT_ID.test(input.reference) ||
      account === null ||
      !ACCOUNT_ID.test(account)
    ) {
      return null;
    }
    const refunds: RefundObservation[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < REFUND_LIST_MAX_PAGES; page++) {
      let list: Stripe.ApiList<Stripe.Refund>;
      try {
        list = await this.stripe.refunds.list(
          {
            payment_intent: input.reference,
            limit: REFUND_LIST_PAGE_SIZE,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          },
          { stripeAccount: account },
        );
      } catch {
        return null;
      }
      if (!list || !Array.isArray(list.data)) return null;
      for (const item of list.data) {
        const observed = observeRefund(item, input.reference);
        if (!observed) return null;
        refunds.push(observed);
      }
      if (!list.has_more || list.data.length === 0) {
        return { refunds, complete: true };
      }
      startingAfter = list.data[list.data.length - 1].id;
    }
    return { refunds, complete: false };
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
