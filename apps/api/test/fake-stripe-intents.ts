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

interface StoredIntent {
  intent: Stripe.PaymentIntent;
  account: string;
}

export class FakeStripeIntents {
  readonly intents = new Map<string, StoredIntent>();
  private readonly byKey = new Map<string, { id: string; params: string }>();
  private next = 1;
  // Make the next create / retrieve throw this (one shot each).
  createError: unknown = null;
  retrieveError: unknown = null;
  // Report this amount as created (a misbehaving answer).
  createAmountOverride: number | null = null;

  readonly create: jest.Mock<
    ReturnType<CreateIntent>,
    Parameters<CreateIntent>
  > = jest.fn(
    (
      params: Stripe.PaymentIntentCreateParams,
      options: { stripeAccount: string; idempotencyKey: string },
    ): Promise<Stripe.PaymentIntent> => {
      if (this.createError) {
        const error = this.createError;
        this.createError = null;
        return Promise.reject(error);
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
          metadata: { ...(params.metadata as Record<string, string>) },
          capture_method: 'automatic',
        } as unknown as Stripe.PaymentIntent,
      });
      return Promise.resolve(this.copy(id));
    },
  );

  readonly retrieve: jest.Mock<
    ReturnType<RetrieveIntent>,
    Parameters<RetrieveIntent>
  > = jest.fn(
    (
      id: string,
      _params: unknown,
      options: { stripeAccount: string },
    ): Promise<Stripe.PaymentIntent> => {
      if (this.retrieveError) {
        const error = this.retrieveError;
        this.retrieveError = null;
        return Promise.reject(error);
      }
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

  // What the customer (or Stripe) did next.
  set(id: string, change: Partial<Stripe.PaymentIntent>): void {
    const stored = this.intents.get(id)!;
    stored.intent = { ...stored.intent, ...change } as Stripe.PaymentIntent;
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
      last_payment_error: {
        type: 'card_error',
      } as Stripe.PaymentIntent.LastPaymentError,
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
