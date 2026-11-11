import Stripe from 'stripe';
import {
  STRIPE_PAYMENTS_API_VERSION,
  StripePaymentIntentProvider,
} from '../src/restaurant-payments/provider/stripe-payment-intent-provider';

// ESP-04 M3 — an OFFLINE stand-in for the Stripe PaymentIntents API, for the
// specs only: the real SDK object with its paymentIntents calls replaced by an
// in-memory store, per connected account (the Stripe-Account header), with
// Stripe's idempotency rules (the same key on the same account returns the
// same intent; the same key with other parameters is refused). Nothing leaves
// the process; no Stripe account or credential is involved.
//
// Webhook signing keys and API keys here are plain test strings in the
// credential FORMATS only, assembled at run time ("TESTONLY"): never valid
// Stripe credentials.

export const testOnly = (prefix: string): string =>
  `${prefix}_${'TESTONLY'.repeat(3)}`;
export const PAYMENTS_SIGNING_SECRET =
  'test-only-payments-signing-key-not-a-stripe-secret';

type CreateIntent = (
  params: Stripe.PaymentIntentCreateParams,
  options: { stripeAccount: string; idempotencyKey: string },
) => Promise<Stripe.PaymentIntent>;
type RetrieveIntent = (
  id: string,
  params: unknown,
  options: { stripeAccount: string },
) => Promise<Stripe.PaymentIntent>;
type CancelIntent = (
  id: string,
  params: Stripe.PaymentIntentCancelParams,
  options: { stripeAccount: string; idempotencyKey?: string },
) => Promise<Stripe.PaymentIntent>;

// ESP-04 M4b — the states Stripe lets a PaymentIntent be cancelled from.
const CANCELABLE = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'requires_capture',
]);

interface StoredIntent {
  intent: Stripe.PaymentIntent;
  account: string;
}

export class FakeStripeIntents {
  readonly intents = new Map<string, StoredIntent>();
  private readonly byKey = new Map<string, { id: string; params: string }>();
  private next = 1;
  // Make the next create / retrieve reject with this (one shot each); null
  // drops any one-shot rejection not used yet. Queued on the mock itself, so
  // any value — an SDK error or a non-Error throw — is passed through exactly
  // as given.
  set createError(error: unknown) {
    oneShotRejection(this.create, error);
  }
  set retrieveError(error: unknown) {
    oneShotRejection(this.retrieve, error);
  }
  // ESP-04 M4b — make the next cancel reject (it may still have reached
  // Stripe: see cancelActsBeforeError).
  set cancelError(error: unknown) {
    oneShotRejection(this.stripeCancel, error);
  }
  // ESP-04 M4b — the next cancel takes effect at Stripe, but its answer is
  // lost (a timeout after Stripe acted).
  loseNextCancelResponse = false;
  // ESP-04 M4b — run just before a cancel is applied (to race a payment).
  beforeCancel: ((id: string) => void) | null = null;
  // Report this amount as created (a misbehaving answer).
  createAmountOverride: number | null = null;
  // ESP-04 M4a — the next creation REACHES Stripe (the intent exists) but
  // its answer is lost on the way back (a timeout after Stripe acted).
  loseNextCreateResponse = false;
  // ESP-04 M4a — idempotency keys whose first request Stripe answered with a
  // 500 it SAVED: every retry with the same key gets that same 500 back
  // (Stripe API v1), and no intent exists.
  readonly saved500Keys = new Set<string>();

  readonly create: jest.Mock<
    ReturnType<CreateIntent>,
    Parameters<CreateIntent>
  > = jest.fn(
    (
      params: Stripe.PaymentIntentCreateParams,
      options: { stripeAccount: string; idempotencyKey: string },
    ): Promise<Stripe.PaymentIntent> => {
      if (this.saved500Keys.has(options.idempotencyKey)) {
        return Promise.reject(stripeError('StripeAPIError', undefined, 500));
      }
      const key = `${options.stripeAccount}|${options.idempotencyKey}`;
      const serialized = JSON.stringify(params);
      const seen = this.byKey.get(key);
      if (seen) {
        if (seen.params !== serialized) {
          return Promise.reject(
            stripeError('StripeIdempotencyError', 'idempotency_error'),
          );
        }
        return Promise.resolve(this.copy(seen.id));
      }
      const id = `pi_Test${String(this.next++).padStart(6, '0')}`;
      this.byKey.set(key, { id, params: serialized });
      this.intents.set(id, {
        account: options.stripeAccount,
        intent: {
          id,
          object: 'payment_intent',
          livemode: false,
          amount: this.createAmountOverride ?? params.amount,
          amount_received: 0,
          currency: params.currency,
          status: 'requires_payment_method',
          client_secret: `${id}_secret_TESTONLY`,
          last_payment_error: null,
          latest_charge: null,
          next_action: null,
          metadata: { ...(params.metadata as Record<string, string>) },
          capture_method: 'automatic',
        } as unknown as Stripe.PaymentIntent,
      });
      if (this.loseNextCreateResponse) {
        this.loseNextCreateResponse = false;
        return Promise.reject(stripeError('StripeConnectionError'));
      }
      return Promise.resolve(this.copy(id));
    },
  );

  // ESP-04 M4a — Stripe pruned this key (it keeps keys "at least 24
  // hours"): a reuse now would be a NEW request, creating a second intent.
  prune(idempotencyKey: string): void {
    for (const key of [...this.byKey.keys()]) {
      if (key.endsWith(`|${idempotencyKey}`)) this.byKey.delete(key);
    }
  }
  // The intents created on an account (to prove no second one ever was).
  intentsOn(account: string): string[] {
    return [...this.intents.entries()]
      .filter(([, stored]) => stored.account === account)
      .map(([id]) => id);
  }

  readonly retrieve: jest.Mock<
    ReturnType<RetrieveIntent>,
    Parameters<RetrieveIntent>
  > = jest.fn(
    (
      id: string,
      _params: unknown,
      options: { stripeAccount: string },
    ): Promise<Stripe.PaymentIntent> => {
      const stored = this.intents.get(id);
      // Another account's intent does not exist on this one.
      if (!stored || stored.account !== options?.stripeAccount) {
        return Promise.reject(
          stripeError('StripeInvalidRequestError', 'resource_missing'),
        );
      }
      return Promise.resolve(this.copy(id));
    },
  );

  // ESP-04 M4b — Stripe's cancel: only from a cancelable state, on the
  // intent's own account; otherwise refused (and nothing changes).
  readonly stripeCancel: jest.Mock<
    ReturnType<CancelIntent>,
    Parameters<CancelIntent>
  > = jest.fn(
    (
      id: string,
      params: Stripe.PaymentIntentCancelParams,
      options: { stripeAccount: string; idempotencyKey?: string },
    ): Promise<Stripe.PaymentIntent> => {
      this.beforeCancel?.(id);
      const stored = this.intents.get(id);
      if (!stored || stored.account !== options?.stripeAccount) {
        return Promise.reject(
          stripeError('StripeInvalidRequestError', 'resource_missing'),
        );
      }
      if (stored.intent.status === 'canceled') {
        return Promise.resolve(this.copy(id));
      }
      if (!CANCELABLE.has(stored.intent.status)) {
        return Promise.reject(
          stripeError(
            'StripeInvalidRequestError',
            'payment_intent_unexpected_state',
          ),
        );
      }
      this.set(id, {
        status: 'canceled',
        cancellation_reason: params.cancellation_reason ?? null,
      });
      if (this.loseNextCancelResponse) {
        this.loseNextCancelResponse = false;
        return Promise.reject(stripeError('StripeConnectionError'));
      }
      return Promise.resolve(this.copy(id));
    },
  );

  // What the customer (or Stripe) did next.
  set(id: string, change: Partial<Stripe.PaymentIntent>): void {
    const stored = this.intents.get(id)!;
    stored.intent = { ...stored.intent, ...change };
  }
  succeed(id: string, amountReceived?: number): void {
    const intent = this.intents.get(id)!.intent;
    this.set(id, {
      status: 'succeeded',
      amount_received: amountReceived ?? intent.amount,
      last_payment_error: null,
    });
  }
  decline(id: string): void {
    this.set(id, {
      status: 'requires_payment_method',
      last_payment_error: { type: 'card_error' },
    });
  }
  process(id: string): void {
    this.set(id, { status: 'processing' });
  }
  cancel(id: string): void {
    this.set(id, { status: 'canceled' });
  }
  only(): string {
    const ids = [...this.intents.keys()];
    if (ids.length !== 1)
      throw new Error(`expected one intent, have ${ids.length}`);
    return ids[0];
  }
  last(): string {
    const ids = [...this.intents.keys()];
    return ids[ids.length - 1];
  }

  private copy(id: string): Stripe.PaymentIntent {
    return structuredClone(this.intents.get(id)!.intent);
  }

  // --- ESP-04 M5a — refunds, per connected account, with Stripe's rules: a
  // refund is only of a succeeded intent, never more than is left of it
  // (pending and succeeded refunds count), and the same key on the same
  // account returns the same refund (other parameters: refused).
  readonly refunds = new Map<
    string,
    { refund: Stripe.Refund; account: string }
  >();
  private readonly byRefundKey = new Map<
    string,
    { id: string; params: string }
  >();
  private nextRefund = 1;
  set refundCreateError(error: unknown) {
    oneShotRejection(this.refundCreate, error);
  }
  set refundRetrieveError(error: unknown) {
    oneShotRejection(this.refundRetrieve, error);
  }
  set refundListError(error: unknown) {
    oneShotRejection(this.refundList, error);
  }
  // The next refund is made at Stripe, but its answer is lost.
  loseNextRefundResponse = false;
  // Report this amount for the next refund made (a misbehaving answer).
  refundAmountOverride: number | null = null;

  readonly refundCreate: jest.Mock<
    Promise<Stripe.Refund>,
    [
      Stripe.RefundCreateParams,
      { stripeAccount: string; idempotencyKey: string },
    ]
  > = jest.fn(
    (
      params: Stripe.RefundCreateParams,
      options: { stripeAccount: string; idempotencyKey: string },
    ): Promise<Stripe.Refund> => {
      const key = `${options.stripeAccount}|${options.idempotencyKey}`;
      const serialized = JSON.stringify(params);
      const seen = this.byRefundKey.get(key);
      if (seen) {
        if (seen.params !== serialized) {
          return Promise.reject(
            stripeError('StripeIdempotencyError', 'idempotency_error'),
          );
        }
        return Promise.resolve(this.refundCopy(seen.id));
      }
      const intentId = String(params.payment_intent);
      const stored = this.intents.get(intentId);
      if (!stored || stored.account !== options.stripeAccount) {
        return Promise.reject(
          stripeError('StripeInvalidRequestError', 'resource_missing'),
        );
      }
      if (stored.intent.status !== 'succeeded') {
        return Promise.reject(
          stripeError('StripeInvalidRequestError', 'charge_not_refundable'),
        );
      }
      const left = stored.intent.amount_received - this.refundedOf(intentId);
      const amount = params.amount ?? left;
      if (left <= 0) {
        return Promise.reject(
          stripeError('StripeInvalidRequestError', 'charge_already_refunded'),
        );
      }
      if (amount > left) {
        return Promise.reject(
          stripeError('StripeInvalidRequestError', 'amount_too_large'),
        );
      }
      const id = this.makeRefund(intentId, options.stripeAccount, {
        amount: this.refundAmountOverride ?? amount,
        status: 'succeeded',
        reason: params.reason ?? null,
        metadata: { ...(params.metadata as Record<string, string>) },
      });
      this.byRefundKey.set(key, { id, params: serialized });
      if (this.loseNextRefundResponse) {
        this.loseNextRefundResponse = false;
        return Promise.reject(stripeError('StripeConnectionError'));
      }
      return Promise.resolve(this.refundCopy(id));
    },
  );

  readonly refundRetrieve: jest.Mock<
    Promise<Stripe.Refund>,
    [string, unknown, { stripeAccount: string }]
  > = jest.fn(
    (
      id: string,
      _params: unknown,
      options: { stripeAccount: string },
    ): Promise<Stripe.Refund> => {
      const stored = this.refunds.get(id);
      if (!stored || stored.account !== options?.stripeAccount) {
        return Promise.reject(
          stripeError('StripeInvalidRequestError', 'resource_missing'),
        );
      }
      return Promise.resolve(this.refundCopy(id));
    },
  );

  readonly refundList: jest.Mock<
    Promise<Stripe.ApiList<Stripe.Refund>>,
    [Stripe.RefundListParams, { stripeAccount: string }]
  > = jest.fn(
    (
      params: Stripe.RefundListParams,
      options: { stripeAccount: string },
    ): Promise<Stripe.ApiList<Stripe.Refund>> => {
      // Newest first, like Stripe.
      const all = [...this.refunds.values()]
        .filter(
          (r) =>
            r.account === options?.stripeAccount &&
            r.refund.payment_intent === params.payment_intent,
        )
        .map((r) => r.refund)
        .reverse();
      const start = params.starting_after
        ? all.findIndex((r) => r.id === params.starting_after) + 1
        : 0;
      const limit = params.limit ?? 10;
      const page = all.slice(start, start + limit);
      return Promise.resolve({
        object: 'list',
        data: page.map((r) => structuredClone(r)),
        has_more: start + limit < all.length,
        url: '/v1/refunds',
      } as Stripe.ApiList<Stripe.Refund>);
    },
  );

  // A refund made in the restaurant's Stripe Dashboard (no CENTERIVO
  // metadata), or one changed at Stripe afterwards (pending -> succeeded, a
  // late failure).
  dashboardRefund(
    intentId: string,
    amount: number,
    status: Stripe.Refund['status'] = 'succeeded',
  ): string {
    const stored = this.intents.get(intentId)!;
    return this.makeRefund(intentId, stored.account, {
      amount,
      status,
      reason: 'requested_by_customer',
      metadata: {},
    });
  }
  setRefund(id: string, change: Partial<Stripe.Refund>): void {
    const stored = this.refunds.get(id)!;
    stored.refund = { ...stored.refund, ...change };
  }

  // Pending and succeeded refunds of an intent (what Stripe holds back).
  refundedOf(intentId: string): number {
    return [...this.refunds.values()]
      .filter(
        (r) =>
          r.refund.payment_intent === intentId &&
          (r.refund.status === 'succeeded' || r.refund.status === 'pending'),
      )
      .reduce((sum, r) => sum + r.refund.amount, 0);
  }

  private makeRefund(
    intentId: string,
    account: string,
    values: {
      amount: number;
      status: Stripe.Refund['status'];
      reason: string | null;
      metadata: Record<string, string>;
    },
  ): string {
    const id = `re_Test${String(this.nextRefund++).padStart(6, '0')}`;
    const intent = this.intents.get(intentId)!.intent;
    this.refunds.set(id, {
      account,
      refund: {
        id,
        object: 'refund',
        amount: values.amount,
        currency: intent.currency,
        payment_intent: intentId,
        charge: `ch_${intentId.slice(3)}`,
        status: values.status,
        reason: values.reason,
        metadata: values.metadata,
        failure_reason: undefined,
        created: Math.floor(Date.now() / 1000),
      } as unknown as Stripe.Refund,
    });
    return id;
  }

  private refundCopy(id: string): Stripe.Refund {
    return structuredClone(this.refunds.get(id)!.refund);
  }
}

function oneShotRejection<T, A extends unknown[]>(
  mock: jest.Mock<Promise<T>, A>,
  error: unknown,
): void {
  if (error !== null) {
    mock.mockRejectedValueOnce(error);
    return;
  }
  // mockReset also forgets the real implementation: put it back.
  const implementation = mock.getMockImplementation();
  mock.mockReset();
  if (implementation) mock.mockImplementation(implementation);
}

// An SDK error of the given class (what the SDK throws), with no provider
// text worth logging.
export function stripeError(
  type: string,
  code?: string,
  statusCode?: number,
): Error {
  return Object.assign(new Error(`simulated ${type}`), {
    type,
    ...(code ? { code } : {}),
    ...(statusCode ? { statusCode } : {}),
  });
}

export function fakeStripePayments(allowedTenantIds: Set<string>): {
  stripe: Stripe;
  intents: FakeStripeIntents;
  provider: StripePaymentIntentProvider;
} {
  const stripe = new Stripe(testOnly('sk_test'), {
    apiVersion: STRIPE_PAYMENTS_API_VERSION,
  });
  const intents = new FakeStripeIntents();
  const api = stripe.paymentIntents as unknown as Record<string, unknown>;
  api.create = intents.create;
  api.retrieve = intents.retrieve;
  api.cancel = intents.stripeCancel;
  // ESP-04 M5a — refunds.
  const refunds = stripe.refunds as unknown as Record<string, unknown>;
  refunds.create = intents.refundCreate;
  refunds.retrieve = intents.refundRetrieve;
  refunds.list = intents.refundList;
  const provider = new StripePaymentIntentProvider(stripe, {
    publishableKey: testOnly('pk_test'),
    paymentsWebhookSecret: PAYMENTS_SIGNING_SECRET,
    allowedTenantIds,
  });
  return { stripe, intents, provider };
}

// A signed payment event, as Stripe would deliver it to the payments
// endpoint (classic snapshot event from a connected account).
export function signedPaymentEvent(
  stripe: Stripe,
  event: {
    id: string;
    type: string;
    account: string | null;
    intent: { id: string; metadata?: Record<string, string> } | null;
    livemode?: boolean;
  },
  secret = PAYMENTS_SIGNING_SECRET,
): { rawBody: Buffer; signatureHeader: string } {
  const payload = JSON.stringify({
    id: event.id,
    object: 'event',
    type: event.type,
    livemode: event.livemode ?? false,
    ...(event.account ? { account: event.account } : {}),
    data: {
      object: event.intent
        ? {
            id: event.intent.id,
            object: 'payment_intent',
            // A body's status is never trusted; deliberately misleading.
            status: 'succeeded',
            metadata: event.intent.metadata ?? {},
          }
        : { id: 'cus_x', object: 'customer' },
    },
  });
  return {
    rawBody: Buffer.from(payload),
    signatureHeader: stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
    }),
  };
}
