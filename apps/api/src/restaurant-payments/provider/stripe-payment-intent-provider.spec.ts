import type Stripe from 'stripe';
import {
  PaymentEventVerificationError,
  resultOf,
} from './stripe-payment-intent-provider';
import {
  fakeStripePayments,
  signedPaymentEvent,
  stripeError,
  testOnly,
} from '../../../test/fake-stripe-intents';

// ESP-04 M3 — the Stripe PaymentIntents adapter, OFFLINE: the SDK's intent
// calls are replaced by an in-memory store (no network, no Stripe account),
// and webhook signatures are produced and checked with the SDK's own
// helpers. Covers what is asked of Stripe (a direct charge on the connected
// account, cards only, automatic capture, our key, our ids only), how every
// Stripe state maps (a NEW intent is not a refused one), safeguard 1 (no
// Stripe answer at creation is ever a definitive "nothing charged"; only a
// local refusal is), test mode, and payment-event verification.

const T1 = '01a0db02-f800-7000-8000-000000000001';
const ACCT = 'acct_1M3Test';
const account = { tenantId: T1, connectedAccountId: ACCT };
const request = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: 'ck_test-key-1',
  amount: 1250,
  currency: 'USD',
  account,
  metadata: { paymentAttemptId: 'pa-1', guestPhone: '5551234567' },
  ...over,
});

function setup(allowed: string[] = [T1]) {
  return fakeStripePayments(new Set(allowed));
}

describe('ESP-04 M3 Stripe PaymentIntents adapter (offline)', () => {
  it('creates a direct charge on the connected account: cards only, automatic capture, our key, our ids and nothing personal', async () => {
    const { provider, intents } = setup();
    const result = await provider.createPaymentIntent(request());
    expect(result).toEqual({
      status: 'requires_customer_action',
      reference: intents.only(),
      // ESP-04 M4a — what the intent is for.
      amount: 1250,
      currency: 'USD',
    });
    expect(intents.create).toHaveBeenCalledTimes(1);
    const [params, options] = intents.create.mock.calls[0];
    expect(params).toEqual({
      amount: 1250,
      currency: 'usd',
      payment_method_types: ['card'],
      capture_method: 'automatic',
      metadata: {
        centerivo_payment_attempt_id: 'pa-1',
        centerivo_tenant_id: T1,
      },
    });
    expect(JSON.stringify(params)).not.toContain('5551234567');
    expect(params).not.toHaveProperty('application_fee_amount');
    expect(params).not.toHaveProperty('receipt_email');
    expect(params).not.toHaveProperty('customer');
    expect(options).toEqual({
      stripeAccount: ACCT,
      idempotencyKey: 'ck_test-key-1',
    });
  });

  it('returns the SAME intent for a retried creation under the same key', async () => {
    const { provider, intents } = setup();
    const first = await provider.createPaymentIntent(request());
    const again = await provider.createPaymentIntent(request());
    expect(again).toEqual(first);
    expect(intents.intents.size).toBe(1);
  });

  it.each([
    [
      'no connected account',
      { account: { tenantId: T1, connectedAccountId: null } },
    ],
    [
      'a malformed account',
      { account: { tenantId: T1, connectedAccountId: 'acct-x' } },
    ],
    ['another currency', { currency: 'EUR' }],
    ['below the Stripe minimum', { amount: 49 }],
    ['a fractional amount', { amount: 100.5 }],
    [
      'a business not on the allowlist',
      { account: { tenantId: 'other', connectedAccountId: ACCT } },
    ],
  ])(
    'refuses LOCALLY (nothing sent, so definitively nothing charged): %s',
    async (_label, over) => {
      const { provider, intents } = setup();
      const result = await provider.createPaymentIntent(request(over));
      expect(result.status).toBe('failed');
      expect(intents.create).not.toHaveBeenCalled();
    },
  );

  // Safeguard 1 — no Stripe error is evidence that no intent exists.
  it.each([
    [
      '400 invalid request',
      stripeError(
        'StripeInvalidRequestError',
        'parameter_invalid_integer',
        400,
      ),
    ],
    [
      '400 amount too small',
      stripeError('StripeInvalidRequestError', 'amount_too_small', 400),
    ],
    [
      '401 authentication',
      stripeError('StripeAuthenticationError', undefined, 401),
    ],
    ['403 permission', stripeError('StripePermissionError', undefined, 403)],
    [
      'idempotency conflict',
      stripeError('StripeIdempotencyError', 'idempotency_error', 400),
    ],
    [
      '409 lock timeout',
      stripeError('StripeInvalidRequestError', 'lock_timeout', 409),
    ],
    ['429 rate limit', stripeError('StripeRateLimitError', 'rate_limit', 429)],
    ['500 api error', stripeError('StripeAPIError', undefined, 500)],
    ['connection error', stripeError('StripeConnectionError')],
    ['a timeout', new Error('ETIMEDOUT')],
    ['a non-error throw', 'boom'],
  ])(
    'a Stripe %s at creation is UNKNOWN (held), never failed',
    async (_label, error) => {
      const { provider, intents } = setup();
      intents.createError = error;
      const result = await provider.createPaymentIntent(request());
      expect(result.status).toBe('unknown');
      // A fixed code only — never provider text.
      expect((result as { reason: string }).reason).toMatch(
        /^stripe_create:[A-Za-z0-9_:]+$/,
      );
      expect((result as { reason: string }).reason).not.toContain('simulated');
    },
  );

  it('an answer for another amount is UNKNOWN (kept with its reference for people)', async () => {
    const { provider, intents } = setup();
    intents.createAmountOverride = 999;
    const result = await provider.createPaymentIntent(request());
    expect(result).toEqual({
      status: 'unknown',
      reason: 'stripe_create:unexpected_answer',
      reference: intents.only(),
    });
  });

  it('maps every intent state, telling a NEW intent from a refused one', () => {
    const base = {
      id: 'pi_1',
      livemode: false,
      amount: 1250,
      amount_received: 0,
      currency: 'usd',
      last_payment_error: null,
    };
    const of = (over: Record<string, unknown>) =>
      resultOf({ ...base, ...over } as unknown as Stripe.PaymentIntent);
    expect(of({ status: 'requires_payment_method' })).toEqual({
      status: 'requires_customer_action',
      reference: 'pi_1',
      amount: 1250,
      currency: 'USD',
    });
    expect(
      of({
        status: 'requires_payment_method',
        last_payment_error: { type: 'card_error' },
      }),
    ).toEqual({
      status: 'requires_payment_method',
      reference: 'pi_1',
      amount: 1250,
      currency: 'USD',
    });
    expect(of({ status: 'requires_confirmation' }).status).toBe(
      'requires_customer_action',
    );
    expect(of({ status: 'requires_action' }).status).toBe(
      'requires_customer_action',
    );
    expect(of({ status: 'processing' }).status).toBe('processing');
    expect(of({ status: 'succeeded', amount_received: 1250 })).toEqual({
      status: 'succeeded',
      reference: 'pi_1',
      amount: 1250,
      currency: 'USD',
    });
    expect(of({ status: 'canceled' })).toEqual({
      status: 'canceled',
      reference: 'pi_1',
    });
    // Cancelled with money taken, manual capture, anything new, live mode:
    // never definitive.
    expect(of({ status: 'canceled', amount_received: 100 }).status).toBe(
      'unknown',
    );
    // Money received on any intent that is not succeeded: never moved on.
    for (const status of [
      'requires_payment_method',
      'requires_action',
      'processing',
    ]) {
      expect(of({ status, amount_received: 100 }).status).toBe('unknown');
    }
    expect(of({ status: 'requires_capture' }).status).toBe('unknown');
    expect(of({ status: 'something_new' }).status).toBe('unknown');
    expect(of({ status: 'succeeded', livemode: true }).status).toBe('unknown');
  });

  it('reads an intent only on its own account; anything else is unknown', async () => {
    const { provider, intents } = setup();
    const created = await provider.createPaymentIntent(request());
    const reference = (created as { reference: string }).reference;
    intents.succeed(reference);
    await expect(
      provider.retrievePaymentIntent({ reference, account }),
    ).resolves.toEqual({
      status: 'succeeded',
      reference,
      amount: 1250,
      currency: 'USD',
    });
    expect(intents.retrieve).toHaveBeenLastCalledWith(
      reference,
      {},
      { stripeAccount: ACCT },
    );
    // Another business's account: Stripe has no such intent there.
    await expect(
      provider.retrievePaymentIntent({
        reference,
        account: { tenantId: 'b', connectedAccountId: 'acct_1Other' },
      }),
    ).resolves.toMatchObject({ status: 'unknown' });
    intents.retrieveError = stripeError('StripeAPIError', undefined, 500);
    await expect(
      provider.retrievePaymentIntent({ reference, account }),
    ).resolves.toMatchObject({ status: 'unknown' });
    // A malformed reference is never sent.
    intents.retrieve.mockClear();
    await expect(
      provider.retrievePaymentIntent({ reference: 'fakepi_1', account }),
    ).resolves.toMatchObject({ status: 'unknown' });
    expect(intents.retrieve).not.toHaveBeenCalled();
  });

  it('hands out the client secret fresh from Stripe, and throws when it cannot', async () => {
    const { provider, intents } = setup();
    const created = await provider.createPaymentIntent(request());
    const reference = (created as { reference: string }).reference;
    await expect(
      provider.clientSecretFor({ reference, account }),
    ).resolves.toBe(`${reference}_secret_TESTONLY`);
    intents.retrieveError = stripeError('StripeConnectionError');
    await expect(
      provider.clientSecretFor({ reference, account }),
    ).rejects.toThrow('stripe_client_secret:unavailable');
  });

  it('never cancels (ESP-04 M4) and never takes a one-step charge (gift cards stay off)', async () => {
    const { provider, intents } = setup();
    expect(provider.acceptsOneStepCharges).toBe(false);
    await expect(provider.charge()).resolves.toMatchObject({
      outcome: 'failed',
    });
    await expect(
      provider.cancelPaymentIntent({ reference: 'pi_1' }),
    ).resolves.toMatchObject({ status: 'unknown' });
    expect(intents.create).not.toHaveBeenCalled();
    expect(intents.retrieve).not.toHaveBeenCalled();
  });

  it('verifies payment events by signature over the raw body, with its own secret', () => {
    const { stripe, provider } = setup();
    const good = signedPaymentEvent(stripe, {
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      account: ACCT,
      intent: {
        id: 'pi_1',
        metadata: { centerivo_payment_attempt_id: 'pa-1' },
      },
    });
    const event = provider.verifyPaymentEvent(good);
    expect(event).toMatchObject({
      provider: 'stripe',
      externalEventId: 'evt_1',
      type: 'payment_intent.succeeded',
      livemode: false,
      externalAccountId: ACCT,
      externalObjectId: 'pi_1',
      claimsCenterivo: true,
    });
    expect(event.payloadDigest).toMatch(/^[0-9a-f]{64}$/);

    // Another endpoint's secret (e.g. the account-events or billing one).
    const otherSecret = signedPaymentEvent(
      stripe,
      {
        id: 'evt_2',
        type: 'payment_intent.succeeded',
        account: ACCT,
        intent: { id: 'pi_1' },
      },
      'test-only-other-signing-key-not-a-stripe-secret',
    );
    expect(() => provider.verifyPaymentEvent(otherSecret)).toThrow(
      PaymentEventVerificationError,
    );
    // Tampered body; no header.
    expect(() =>
      provider.verifyPaymentEvent({
        rawBody: Buffer.from(good.rawBody.toString().replace('pi_1', 'pi_2')),
        signatureHeader: good.signatureHeader,
      }),
    ).toThrow(PaymentEventVerificationError);
    expect(() =>
      provider.verifyPaymentEvent({
        rawBody: good.rawBody,
        signatureHeader: undefined,
      }),
    ).toThrow(PaymentEventVerificationError);
    // An event naming no CENTERIVO metadata does not claim to be ours.
    const theirs = provider.verifyPaymentEvent(
      signedPaymentEvent(stripe, {
        id: 'evt_3',
        type: 'payment_intent.succeeded',
        account: ACCT,
        intent: { id: 'pi_9' },
      }),
    );
    expect(theirs.claimsCenterivo).toBe(false);
  });

  it('exposes only the publishable key and the allowlist decision', () => {
    const { provider } = setup();
    expect(provider.publishableKey).toBe(testOnly('pk_test'));
    expect(provider.allowsTenant(T1)).toBe(true);
    expect(provider.allowsTenant('another-business')).toBe(false);
  });
});
