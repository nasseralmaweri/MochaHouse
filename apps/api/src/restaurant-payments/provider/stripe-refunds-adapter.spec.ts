import type Stripe from 'stripe';
import { observeRefund } from './stripe-payment-intent-provider';
import {
  fakeStripePayments,
  stripeError,
} from '../../../test/fake-stripe-intents';

// ESP-04 M5a — the Stripe refund adapter, OFFLINE (no network, no Stripe
// account): a refund is asked for on the ORIGINAL payment intent, on the
// connected account it was made on, with the operation's own key and our ids
// only; the only definitive "nothing was refunded" is a local refusal; every
// Stripe error or odd answer is "unknown"; and refunds are read back only on
// the payment's own account, only for that intent.

const T1 = '01a0db02-f800-7000-8000-000000000001';
const ACCT = 'acct_1M5Test';
const OTHER_ACCT = 'acct_1M5Other';
const account = { tenantId: T1, connectedAccountId: ACCT };
const REFUND_ID = '01a0db02-f800-7000-8000-0000000000r1';

async function paidIntent(amount = 2000) {
  const { provider, intents } = fakeStripePayments(new Set([T1]));
  await provider.createPaymentIntent({
    idempotencyKey: 'ck_refund-test',
    amount,
    currency: 'USD',
    account,
    metadata: { paymentAttemptId: 'pa-1' },
  });
  const reference = intents.only();
  intents.succeed(reference);
  return { provider, intents, reference };
}

const ask = (
  reference: string,
  over: Partial<{
    amountMinorUnits: number;
    currency: string;
    reason: 'requested_by_customer' | 'duplicate';
    refundId: string;
    idempotencyKey: string;
    reference: string;
    account: typeof account;
  }> = {},
) => ({
  reference,
  account,
  amountMinorUnits: 500,
  currency: 'USD',
  reason: 'requested_by_customer' as const,
  refundId: REFUND_ID,
  tenantId: T1,
  idempotencyKey: `centerivo-refund:${REFUND_ID}`,
  ...over,
});

describe('ESP-04 M5a Stripe refund adapter (offline)', () => {
  it('refunds the original intent on its own connected account, with the operation key and our ids only', async () => {
    const { provider, intents, reference } = await paidIntent();
    const outcome = await provider.createRefund(ask(reference));
    if (outcome.kind !== 'observed') throw new Error('expected a refund');
    expect(outcome.refund.providerRefundId).toMatch(/^re_/);
    expect(outcome).toEqual({
      kind: 'observed',
      refund: {
        providerRefundId: outcome.refund.providerRefundId,
        state: 'succeeded',
        amountMinorUnits: 500,
        currency: 'USD',
        centerivoRefundId: REFUND_ID,
        failureReason: null,
      },
    });
    expect(intents.refundCreate).toHaveBeenCalledTimes(1);
    const [params, options] = intents.refundCreate.mock.calls[0];
    expect(params).toEqual({
      payment_intent: reference,
      amount: 500,
      reason: 'requested_by_customer',
      metadata: { centerivo_tenant_id: T1, centerivo_refund_id: REFUND_ID },
    });
    // A direct charge: no application fee to return, no transfer to reverse.
    expect(params).not.toHaveProperty('refund_application_fee');
    expect(params).not.toHaveProperty('reverse_transfer');
    expect(params).not.toHaveProperty('charge');
    expect(options).toEqual({
      stripeAccount: ACCT,
      idempotencyKey: `centerivo-refund:${REFUND_ID}`,
    });
  });

  it.each([
    ['an invalid intent id', { reference: 'ch_not_an_intent' }],
    [
      'no connected account',
      { account: { tenantId: T1, connectedAccountId: null } },
    ],
    [
      'a malformed account',
      { account: { tenantId: T1, connectedAccountId: 'acct-1' } },
    ],
    ['a zero amount', { amountMinorUnits: 0 }],
    ['a fractional amount', { amountMinorUnits: 10.5 }],
    ['a lower-case currency', { currency: 'usd' }],
    ['the fraudulent reason', { reason: 'fraudulent' }],
    ['a malformed refund id', { refundId: 'id with spaces' }],
    ['an empty key', { idempotencyKey: '' }],
    ['an over-long key', { idempotencyKey: 'k'.repeat(256) }],
  ])('refuses locally, sending nothing, with %s', async (_label, over) => {
    const { provider, intents, reference } = await paidIntent();
    const request = { ...ask(reference), ...over } as Parameters<
      typeof provider.createRefund
    >[0];
    expect(await provider.createRefund(request)).toEqual({
      kind: 'refused_locally',
    });
    expect(intents.refundCreate).not.toHaveBeenCalled();
  });

  it.each([
    [
      'too much',
      stripeError('StripeInvalidRequestError', 'amount_too_large', 400),
    ],
    [
      'already refunded',
      stripeError('StripeInvalidRequestError', 'charge_already_refunded', 400),
    ],
    [
      'an idempotency conflict',
      stripeError('StripeIdempotencyError', 'idempotency_error', 400),
    ],
    [
      'a permission error',
      stripeError('StripePermissionError', undefined, 403),
    ],
    ['a rate limit', stripeError('StripeRateLimitError', 'rate_limit', 429)],
    ['a server error', stripeError('StripeAPIError', undefined, 500)],
    ['a lost connection', stripeError('StripeConnectionError')],
    ['a non-Error throw', 'boom'],
  ])(
    'treats %s from Stripe as unknown (the refund may exist), never as "not refunded"',
    async (_label, error) => {
      const { provider, intents, reference } = await paidIntent();
      intents.refundCreateError = error;
      const outcome = await provider.createRefund(ask(reference));
      expect(outcome.kind).toBe('unknown');
    },
  );

  it('a lost answer is recovered by the same key: the same refund comes back, never a second one', async () => {
    const { provider, intents, reference } = await paidIntent();
    intents.loseNextRefundResponse = true;
    expect((await provider.createRefund(ask(reference))).kind).toBe('unknown');
    expect(intents.refunds.size).toBe(1);
    const replay = await provider.createRefund(ask(reference));
    expect(replay.kind).toBe('observed');
    expect(intents.refunds.size).toBe(1);
    // The same key with other parameters is refused by Stripe: unknown.
    expect(
      (await provider.createRefund(ask(reference, { amountMinorUnits: 600 })))
        .kind,
    ).toBe('unknown');
    expect(intents.refunds.size).toBe(1);
  });

  it('an answer that is not this refund (another amount, intent or id) is unknown', async () => {
    const { provider, intents, reference } = await paidIntent();
    intents.refundAmountOverride = 499;
    expect((await provider.createRefund(ask(reference))).kind).toBe('unknown');
    intents.refundAmountOverride = null;
    intents.refundCreate.mockImplementationOnce(() =>
      Promise.resolve({
        id: 're_Elsewhere1',
        object: 'refund',
        amount: 500,
        currency: 'usd',
        payment_intent: 'pi_SomeoneElse',
        status: 'succeeded',
        metadata: { centerivo_refund_id: REFUND_ID },
      } as unknown as Stripe.Refund),
    );
    expect((await provider.createRefund(ask(reference))).kind).toBe('unknown');
    intents.refundCreate.mockImplementationOnce(() =>
      Promise.resolve({
        id: 're_OtherOp1',
        object: 'refund',
        amount: 500,
        currency: 'usd',
        payment_intent: reference,
        status: 'succeeded',
        metadata: { centerivo_refund_id: 'another-operation' },
      } as unknown as Stripe.Refund),
    );
    expect((await provider.createRefund(ask(reference))).kind).toBe('unknown');
  });

  it("reads a refund back only on the payment's own account and only for its intent", async () => {
    const { provider, intents, reference } = await paidIntent();
    const made = await provider.createRefund(ask(reference));
    if (made.kind !== 'observed') throw new Error('expected a refund');
    const id = made.refund.providerRefundId;
    expect(
      await provider.retrieveRefund({
        providerRefundId: id,
        reference,
        account,
      }),
    ).toMatchObject({ providerRefundId: id, state: 'succeeded' });
    expect(
      await provider.retrieveRefund({
        providerRefundId: id,
        reference,
        account: { tenantId: T1, connectedAccountId: OTHER_ACCT },
      }),
    ).toBeNull();
    expect(
      await provider.retrieveRefund({
        providerRefundId: id,
        reference: 'pi_SomeoneElse',
        account,
      }),
    ).toBeNull();
    expect(
      await provider.retrieveRefund({
        providerRefundId: 'not-a-refund',
        reference,
        account,
      }),
    ).toBeNull();
    intents.refundRetrieveError = stripeError('StripeAPIError', undefined, 500);
    expect(
      await provider.retrieveRefund({
        providerRefundId: id,
        reference,
        account,
      }),
    ).toBeNull();
    // A late failure, as Stripe reports it.
    intents.setRefund(id, {
      status: 'failed',
      failure_reason: 'expired_or_canceled_card',
    });
    expect(
      await provider.retrieveRefund({
        providerRefundId: id,
        reference,
        account,
      }),
    ).toMatchObject({
      state: 'failed',
      failureReason: 'expired_or_canceled_card',
    });
  });

  it('lists every refund of the intent (CENTERIVO and Dashboard), across pages, and says when it stopped early', async () => {
    const { provider, intents, reference } = await paidIntent(500_000);
    await provider.createRefund(ask(reference, { amountMinorUnits: 1000 }));
    for (let i = 0; i < 150; i++) intents.dashboardRefund(reference, 10);
    const listed = await provider.listRefundsFor({ reference, account });
    expect(listed?.complete).toBe(true);
    expect(listed?.refunds).toHaveLength(151);
    expect(
      listed?.refunds.filter((r) => r.centerivoRefundId === REFUND_ID),
    ).toHaveLength(1);
    expect(
      listed?.refunds.filter((r) => r.centerivoRefundId === null),
    ).toHaveLength(150);
    // Bounded: more than ten pages of a hundred is reported incomplete.
    for (let i = 0; i < 900; i++) intents.dashboardRefund(reference, 10);
    const capped = await provider.listRefundsFor({ reference, account });
    expect(capped?.complete).toBe(false);
    expect(capped?.refunds).toHaveLength(1000);
    // Another account has none of them; an error reads nothing.
    expect(
      await provider.listRefundsFor({
        reference,
        account: { tenantId: T1, connectedAccountId: OTHER_ACCT },
      }),
    ).toEqual({ refunds: [], complete: true });
    intents.refundListError = stripeError('StripeConnectionError');
    expect(await provider.listRefundsFor({ reference, account })).toBeNull();
  });

  it('reports what a refund needs to know about the payment, from its expanded latest charge', async () => {
    const { provider, intents, reference } = await paidIntent();
    intents.set(reference, {
      latest_charge: {
        id: 'ch_1',
        object: 'charge',
        amount_refunded: 300,
        disputed: false,
      } as Stripe.Charge,
    });
    expect(await provider.refundFactsFor({ reference, account })).toEqual({
      status: 'succeeded',
      amount: 2000,
      amountReceived: 2000,
      currency: 'USD',
      chargeAmountRefunded: 300,
      chargeDisputed: false,
    });
    expect(intents.retrieve).toHaveBeenLastCalledWith(
      reference,
      { expand: ['latest_charge'] },
      { stripeAccount: ACCT },
    );
    // An unexpanded charge proves nothing.
    intents.set(reference, { latest_charge: 'ch_1' });
    expect(await provider.refundFactsFor({ reference, account })).toMatchObject(
      { chargeAmountRefunded: null, chargeDisputed: null },
    );
    // Live, another account's, or unreadable: nothing.
    intents.set(reference, { livemode: true });
    expect(await provider.refundFactsFor({ reference, account })).toBeNull();
    intents.set(reference, { livemode: false });
    expect(
      await provider.refundFactsFor({
        reference,
        account: { tenantId: T1, connectedAccountId: OTHER_ACCT },
      }),
    ).toBeNull();
  });

  it('names Stripe states in our vocabulary and never trusts an odd refund object', () => {
    const base = {
      id: 're_Abc1',
      object: 'refund',
      amount: 100,
      currency: 'usd',
      payment_intent: 'pi_Abc1',
      metadata: {},
    };
    const of = (over: Record<string, unknown>) =>
      observeRefund(
        { ...base, ...over } as unknown as Stripe.Refund,
        'pi_Abc1',
      );
    for (const state of [
      'pending',
      'requires_action',
      'succeeded',
      'failed',
      'canceled',
    ]) {
      expect(of({ status: state })?.state).toBe(state);
    }
    expect(of({ status: 'something_new' })?.state).toBe('unknown');
    expect(
      of({ status: 'failed', failure_reason: 'Not A Code!' })?.failureReason,
    ).toBe('unknown');
    expect(
      of({ status: 'succeeded', metadata: { centerivo_refund_id: 'bad id!' } })
        ?.centerivoRefundId,
    ).toBeNull();
    expect(
      of({ payment_intent: { id: 'pi_Abc1' }, status: 'succeeded' })?.state,
    ).toBe('succeeded');
    expect(of({ amount: 0, status: 'succeeded' })).toBeNull();
    expect(of({ id: 'pyr_1', status: 'succeeded' })).toBeNull();
    expect(of({ payment_intent: 'pi_Other', status: 'succeeded' })).toBeNull();
    expect(observeRefund(null, 'pi_Abc1')).toBeNull();
  });
});
