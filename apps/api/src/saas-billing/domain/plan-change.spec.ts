import type { ProviderSubscriptionSnapshot } from './provider-sync';
import {
  planChangeIdempotencyKey,
  planChangeTiming,
  verifyBilledPrice,
} from './plan-change';

// SC3d — the pure plan-change rules (owner decisions D2–D7).
const price = (
  id: string,
  amountMinorUnits: number,
  interval: 'MONTH' | 'YEAR' = 'MONTH',
  currency = 'USD',
) => ({ id, amountMinorUnits, interval, currency });

describe('SC3d plan change timing', () => {
  const monthly49 = price('m49', 4900);
  it('a higher price at the same interval is an immediate (paid) upgrade', () => {
    expect(planChangeTiming('ACTIVE', monthly49, price('m99', 9900))).toEqual({
      ok: true,
      timing: 'IMMEDIATE',
    });
  });
  it('a lower or equal price at the same interval waits for the period end', () => {
    expect(planChangeTiming('ACTIVE', monthly49, price('m19', 1900))).toEqual({
      ok: true,
      timing: 'PERIOD_END',
    });
    expect(
      planChangeTiming('ACTIVE', monthly49, price('other49', 4900)),
    ).toEqual({
      ok: true,
      timing: 'PERIOD_END',
    });
  });
  it('monthly -> annual is immediate; annual -> monthly waits for the end of the annual term', () => {
    expect(
      planChangeTiming('ACTIVE', monthly49, price('y490', 49000, 'YEAR')),
    ).toEqual({
      ok: true,
      timing: 'IMMEDIATE',
    });
    expect(
      planChangeTiming(
        'ACTIVE',
        price('y490', 49000, 'YEAR'),
        price('m99', 9900),
      ),
    ).toEqual({
      ok: true,
      timing: 'PERIOD_END',
    });
  });
  it('during a trial only the plan after the trial is chosen', () => {
    expect(planChangeTiming('TRIALING', monthly49, price('m99', 9900))).toEqual(
      {
        ok: true,
        timing: 'TRIAL_END',
      },
    );
  });
  it('refuses past due, unpaid, ended, the same price and another currency', () => {
    for (const status of ['PAST_DUE', 'UNPAID', 'TRIAL_EXPIRED', 'CANCELED']) {
      expect(planChangeTiming(status, monthly49, price('m99', 9900))).toEqual({
        ok: false,
        reason: 'NOT_CHANGEABLE',
      });
    }
    expect(planChangeTiming('ACTIVE', monthly49, monthly49)).toEqual({
      ok: false,
      reason: 'SAME_PRICE',
    });
    expect(
      planChangeTiming('ACTIVE', monthly49, price('e99', 9900, 'MONTH', 'EUR')),
    ).toEqual({
      ok: false,
      reason: 'CURRENCY_MISMATCH',
    });
  });
});

describe('SC3d billed price verification', () => {
  const snapshot = (
    over: Partial<ProviderSubscriptionSnapshot> = {},
  ): ProviderSubscriptionSnapshot => ({
    externalSubscriptionId: 'sub_1',
    externalCustomerId: 'cus_1',
    status: 'active',
    livemode: false,
    hasPaymentMethod: true,
    paymentMethodSource: 'SUBSCRIPTION',
    cancelAtPeriodEnd: false,
    trialStart: null,
    trialEnd: null,
    latestInvoiceId: null,
    items: [
      { externalItemId: 'si_1', externalPriceId: 'price_ours', quantity: 1 },
    ],
    scheduleId: null,
    hasPendingUpdate: false,
    currentPeriodEnd: null,
    ...over,
  });

  it('accepts exactly one item at our price', () => {
    expect(verifyBilledPrice(snapshot(), 'price_ours')).toEqual({
      ok: true,
      item: {
        externalItemId: 'si_1',
        externalPriceId: 'price_ours',
        quantity: 1,
      },
    });
  });

  it('fails closed on anything else', () => {
    const problem = (
      over: Partial<ProviderSubscriptionSnapshot>,
      expected: string | null = 'price_ours',
    ) => {
      const result = verifyBilledPrice(snapshot(over), expected);
      return result.ok ? 'OK' : result.problem;
    };
    expect(problem({ items: undefined })).toBe('ITEMS_UNKNOWN');
    expect(problem({ items: [] })).toBe('ITEMS_UNKNOWN');
    expect(
      problem({
        items: [
          {
            externalItemId: 'si_1',
            externalPriceId: 'price_ours',
            quantity: 1,
          },
          { externalItemId: 'si_2', externalPriceId: 'price_x', quantity: 1 },
        ],
      }),
    ).toBe('NOT_ONE_ITEM');
    expect(
      problem({
        items: [
          {
            externalItemId: 'si_1',
            externalPriceId: 'price_ours',
            quantity: 2,
          },
        ],
      }),
    ).toBe('NOT_ONE_ITEM');
    expect(
      problem({
        items: [
          {
            externalItemId: 'si_1',
            externalPriceId: 'price_other',
            quantity: 1,
          },
        ],
      }),
    ).toBe('PRICE_MISMATCH');
    expect(problem({}, null)).toBe('PRICE_MISMATCH');
    expect(problem({ scheduleId: 'sub_sched_1' })).toBe('SCHEDULE_ATTACHED');
    expect(problem({ scheduleId: undefined })).toBe('SCHEDULE_ATTACHED');
    expect(problem({ hasPendingUpdate: true })).toBe('PENDING_UPDATE');
    expect(problem({ hasPendingUpdate: undefined })).toBe('PENDING_UPDATE');
  });
});

it('idempotency keys are scoped to one change and one step', () => {
  expect(planChangeIdempotencyKey('c1', 'change-now')).toBe(
    'centerivo-plan-change-c1-change-now',
  );
  expect(planChangeIdempotencyKey('c1', 'change-now')).not.toBe(
    planChangeIdempotencyKey('c2', 'change-now'),
  );
  expect(planChangeIdempotencyKey('c1', 'schedule')).not.toBe(
    planChangeIdempotencyKey('c1', 'release'),
  );
});
