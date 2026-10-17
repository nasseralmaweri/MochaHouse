import {
  buildTimeline,
  cashOf,
  invariantViolations,
  invoiceFailed,
  monthOf,
  monthWindows,
  mrrOf,
  recurringOf,
  stateAt,
  trialCohorts,
  type AdjustmentInput,
  type InvoiceInput,
  type PriceInfo,
  type SubscriptionInput,
} from './revenue-metrics';

// SC3f — the revenue metrics, pure: contracted recurring revenue without
// accumulated rounding, history rebuilt from events (and flagged when it
// doesn't reach the current record), churn only when a paid subscription
// actually ends, each failed invoice once, refunds and credits never
// double-counted.
const d = (iso: string) => new Date(iso);
const prices = new Map<string, PriceInfo>([
  [
    'pro-m',
    {
      id: 'pro-m',
      planName: 'Pro',
      interval: 'MONTH',
      currency: 'usd',
      amountMinorUnits: 9900,
    },
  ],
  [
    'pro-y',
    {
      id: 'pro-y',
      planName: 'Pro',
      interval: 'YEAR',
      currency: 'usd',
      amountMinorUnits: 99_000,
    },
  ],
  [
    'odd-y',
    {
      id: 'odd-y',
      planName: 'Odd',
      interval: 'YEAR',
      currency: 'usd',
      amountMinorUnits: 1000,
    },
  ],
  [
    'growth-m',
    {
      id: 'growth-m',
      planName: 'Growth',
      interval: 'MONTH',
      currency: 'usd',
      amountMinorUnits: 4900,
    },
  ],
  [
    'eur-m',
    {
      id: 'eur-m',
      planName: 'Pro',
      interval: 'MONTH',
      currency: 'eur',
      amountMinorUnits: 8900,
    },
  ],
]);

const sub = (over: Partial<SubscriptionInput> = {}): SubscriptionInput => ({
  id: 's1',
  createdAt: d('2026-01-01T00:00:00Z'),
  billingMode: 'BILLED',
  status: 'ACTIVE',
  planPriceId: 'pro-m',
  externalSubscriptionId: 'sub_1',
  currentPeriodStart: d('2026-03-10T00:00:00Z'),
  recoveryEndsAt: null,
  events: [],
  checkouts: [
    {
      planPriceId: 'pro-m',
      completedAt: d('2026-01-10T00:00:00Z'),
      replaces: false,
    },
  ],
  grants: [],
  ...over,
});
const ev = (
  type: string,
  at: string,
  from: string | null,
  to: string | null,
  planPriceId: string | null = null,
) => ({
  type,
  fromStatus: from,
  toStatus: to,
  planPriceId,
  at: d(at),
});

describe('SC3f revenue metrics', () => {
  it('MRR from exact ARR, rounded once: no accumulated rounding; PAST_DUE is at risk', () => {
    expect(mrrOf(1000)).toBe(83);
    const three = recurringOf(
      [
        { priceId: 'odd-y', status: 'ACTIVE' },
        { priceId: 'odd-y', status: 'ACTIVE' },
        { priceId: 'odd-y', status: 'ACTIVE' },
      ],
      prices,
    );
    // 3 x 1000 / 12 = 250 exactly (not 3 x 83 = 249).
    expect(three.recurring).toEqual([
      expect.objectContaining({
        currency: 'USD',
        arrMinorUnits: 3000,
        mrrMinorUnits: 250,
      }),
    ]);
    const mixed = recurringOf(
      [
        { priceId: 'pro-m', status: 'ACTIVE' },
        { priceId: 'pro-y', status: 'PAST_DUE' },
        { priceId: 'eur-m', status: 'ACTIVE' },
      ],
      prices,
    );
    expect(mixed.recurring).toEqual([
      {
        currency: 'EUR',
        mrrMinorUnits: 8900,
        arrMinorUnits: 106_800,
        atRiskMrrMinorUnits: 0,
        activePaidSubscriptions: 1,
        atRiskSubscriptions: 0,
        monthlySubscriptions: 1,
        annualSubscriptions: 0,
      },
      {
        currency: 'USD',
        mrrMinorUnits: 9900 + 8250,
        arrMinorUnits: 118_800 + 99_000,
        atRiskMrrMinorUnits: 8250,
        activePaidSubscriptions: 2,
        atRiskSubscriptions: 1,
        monthlySubscriptions: 1,
        annualSubscriptions: 1,
      },
    ]);
    expect(
      mixed.byPlan.map((p) => [
        p.currency,
        p.planName,
        p.interval,
        p.mrrMinorUnits,
      ]),
    ).toEqual([
      ['EUR', 'Pro', 'MONTH', 8900],
      ['USD', 'Pro', 'MONTH', 9900],
      ['USD', 'Pro', 'YEAR', 8250],
    ]);
    expect(invariantViolations([], [], mixed.recurring, mixed.byPlan)).toEqual(
      [],
    );
  });

  it('rebuilds a trial that converted, changed plan and ended — paying only after a verified payment', () => {
    const s = sub({
      status: 'CANCELED',
      planPriceId: 'growth-m',
      currentPeriodStart: null,
      events: [
        ev('TRIAL_STARTED', '2026-01-10T00:00:00Z', 'ACTIVE', 'TRIALING'),
        ev('PAYMENT_SUCCEEDED', '2026-01-24T00:00:00Z', 'TRIALING', 'ACTIVE'),
        ev(
          'PLAN_CHANGE_APPLIED',
          '2026-03-01T00:00:00Z',
          'ACTIVE',
          'ACTIVE',
          'growth-m',
        ),
        ev('PAYMENT_FAILED', '2026-04-01T00:00:00Z', 'ACTIVE', 'PAST_DUE'),
        ev('CANCELED', '2026-04-20T00:00:00Z', 'PAST_DUE', 'CANCELED'),
      ],
    });
    const t = buildTimeline(s);
    expect(t.complete).toBe(true);
    expect(stateAt(t, d('2026-01-15T00:00:00Z').getTime())).toMatchObject({
      paying: false,
      status: 'TRIALING',
    });
    expect(stateAt(t, d('2026-02-01T00:00:00Z').getTime())).toMatchObject({
      paying: true,
      priceId: 'pro-m',
    });
    expect(stateAt(t, d('2026-03-15T00:00:00Z').getTime())).toMatchObject({
      paying: true,
      priceId: 'growth-m',
    });
    expect(stateAt(t, d('2026-04-10T00:00:00Z').getTime())).toMatchObject({
      paying: true,
      status: 'PAST_DUE',
    });
    expect(stateAt(t, d('2026-05-01T00:00:00Z').getTime())).toMatchObject({
      paying: false,
    });
    expect(t.endings).toEqual([
      {
        at: d('2026-04-20T00:00:00Z').getTime(),
        kind: 'CANCELED',
        fromStatus: 'PAST_DUE',
        priceId: 'growth-m',
      },
    ]);
    expect(t.trialOutcome).toBe('CONVERTED');

    const [april] = monthWindows(
      '2026-04',
      '2026-04',
      d('2026-06-01T00:00:00Z'),
    );
    const month = monthOf(april, [t], prices, [], [], () => 0);
    expect(month).toMatchObject({
      status: 'COMPLETE',
      activePaidAtStart: 1,
      activePaidAtEnd: 0,
      churn: {
        ended: 1,
        endedOther: 0,
        movedToComplimentary: 0,
        revenue: [
          {
            currency: 'USD',
            startMrrMinorUnits: 4900,
            churnedMrrMinorUnits: 4900,
          },
        ],
      },
    });
    // A scheduled cancellation is not churn; only the end is.
    const [march] = monthWindows(
      '2026-03',
      '2026-03',
      d('2026-06-01T00:00:00Z'),
    );
    expect(monthOf(march, [t], prices, [], [], () => 0).churn.ended).toBe(0);
  });

  it('started billing but never paid: never counted as paying', () => {
    const t = buildTimeline(
      sub({
        externalSubscriptionId: null,
        currentPeriodStart: null,
        events: [],
        checkouts: [],
      }),
    );
    expect(t.complete).toBe(true);
    expect(stateAt(t, Date.now()).paying).toBe(false);
  });

  it('flags a history that does not reach the current record — never fills it in', () => {
    // A price change with no recorded price.
    const missing = buildTimeline(
      sub({
        events: [
          ev('PAYMENT_SUCCEEDED', '2026-01-10T00:00:00Z', 'ACTIVE', 'ACTIVE'),
          ev(
            'PLAN_CHANGE_APPLIED',
            '2026-02-10T00:00:00Z',
            'ACTIVE',
            'ACTIVE',
            null,
          ),
        ],
      }),
    );
    expect(missing.complete).toBe(false);
    // Paying now, but no payment ever recorded.
    const unexplained = buildTimeline(sub({ events: [] }));
    expect(unexplained.complete).toBe(false);
    const [jan] = monthWindows('2026-01', '2026-01', d('2026-06-01T00:00:00Z'));
    expect(monthOf(jan, [unexplained], prices, [], [], () => 0).status).toBe(
      'INCOMPLETE',
    );
  });

  it('a paid subscription that becomes complimentary is not churn', () => {
    const t = buildTimeline(
      sub({
        billingMode: 'COMPLIMENTARY',
        status: 'ACTIVE',
        planPriceId: null,
        externalSubscriptionId: null,
        currentPeriodStart: null,
        events: [
          ev('PAYMENT_SUCCEEDED', '2026-01-10T00:00:00Z', 'ACTIVE', 'ACTIVE'),
          ev('CANCELED', '2026-03-10T00:00:00Z', 'ACTIVE', 'CANCELED'),
          ev(
            'COMPLIMENTARY_STARTED',
            '2026-03-10T00:01:00Z',
            'CANCELED',
            'ACTIVE',
          ),
        ],
        grants: [
          {
            status: 'ACTIVE',
            previousPlanPriceId: 'pro-m',
            startedAt: d('2026-03-10T00:01:00Z'),
            finishedAt: null,
          },
        ],
      }),
    );
    expect(t.complete).toBe(true);
    const [march] = monthWindows(
      '2026-03',
      '2026-03',
      d('2026-06-01T00:00:00Z'),
    );
    expect(monthOf(march, [t], prices, [], [], () => 1).churn).toMatchObject({
      ended: 0,
      movedToComplimentary: 1,
    });
  });

  it('counts each failed invoice once, recovered only on a verified payment', () => {
    const invoice = (over: Partial<InvoiceInput>): InvoiceInput => ({
      id: 'i',
      status: 'paid',
      currency: 'usd',
      totalMinorUnits: 9900,
      amountDueMinorUnits: 9900,
      amountPaidMinorUnits: 9900,
      balanceAppliedMinorUnits: 0,
      taxMinorUnits: 900,
      totalExcludingTaxMinorUnits: 9000,
      attemptCount: 1,
      issuedAt: d('2026-05-02T00:00:00Z'),
      paidAt: d('2026-05-02T00:00:00Z'),
      ...over,
    });
    expect(invoiceFailed(invoice({}))).toBe(false);
    expect(invoiceFailed(invoice({ attemptCount: 4 }))).toBe(true);
    expect(
      invoiceFailed(
        invoice({ status: 'open', paidAt: null, amountPaidMinorUnits: 0 }),
      ),
    ).toBe(true);
    expect(
      invoiceFailed(invoice({ status: 'open', paidAt: null, attemptCount: 0 })),
    ).toBe(false);
    expect(invoiceFailed(invoice({ attemptCount: null }))).toBeNull();

    const [may] = monthWindows('2026-05', '2026-05', d('2026-06-01T00:00:00Z'));
    const invoices = [
      invoice({ id: 'a' }),
      // Failed three times, paid on the fourth: one failed invoice, recovered.
      invoice({ id: 'b', attemptCount: 4, paidAt: d('2026-05-20T00:00:00Z') }),
      // Failed, still open.
      invoice({
        id: 'c',
        status: 'open',
        paidAt: null,
        amountPaidMinorUnits: 0,
      }),
      // Attempts unknown (recorded before SC3f).
      invoice({
        id: 'd',
        attemptCount: null,
        taxMinorUnits: null,
        totalExcludingTaxMinorUnits: null,
      }),
    ];
    const adjustments: AdjustmentInput[] = [
      {
        invoiceId: 'a',
        origin: 'CENTERIVO',
        kind: 'REFUND',
        currency: 'usd',
        totalMinorUnits: 2000,
        finishedAt: d('2026-05-25T00:00:00Z'),
      },
      {
        invoiceId: 'b',
        origin: 'EXTERNAL',
        kind: 'CREDIT',
        currency: 'usd',
        totalMinorUnits: 1000,
        finishedAt: d('2026-05-26T00:00:00Z'),
      },
    ];
    const { cash, failed, recovered } = cashOf(may, invoices, adjustments);
    expect(failed).toEqual({
      count: 2,
      amountDue: [{ currency: 'USD', minorUnits: 19_800 }],
      unverified: 1,
    });
    expect(recovered).toBe(1);
    expect(cash).toEqual([
      {
        currency: 'USD',
        // Cash collected is what was paid; refunds and credits are reported,
        // never subtracted twice.
        collectedMinorUnits: 9900 * 3,
        // One paid invoice lacks verified tax: unknown, not zero.
        taxMinorUnits: null,
        refundsMinorUnits: 2000,
        refundsOutsideProviderMinorUnits: 0,
        creditsIssuedMinorUnits: 1000,
        balanceAppliedMinorUnits: 0,
        recoveredMinorUnits: 9900,
      },
    ]);
  });

  it('a restart on a new price counts at the new price from its checkout', () => {
    const t = buildTimeline(
      sub({
        planPriceId: 'pro-m',
        checkouts: [
          {
            planPriceId: 'growth-m',
            completedAt: d('2026-01-10T00:00:00Z'),
            replaces: false,
          },
          {
            planPriceId: 'pro-m',
            completedAt: d('2026-06-01T00:00:00Z'),
            replaces: false,
          },
        ],
        events: [
          ev('PAYMENT_SUCCEEDED', '2026-01-10T00:00:01Z', 'ACTIVE', 'ACTIVE'),
          ev('CANCELED', '2026-03-05T00:00:00Z', 'ACTIVE', 'CANCELED'),
          ev('PAYMENT_SUCCEEDED', '2026-06-01T00:00:01Z', 'CANCELED', 'ACTIVE'),
        ],
      }),
    );
    expect(t.complete).toBe(true);
    expect(stateAt(t, d('2026-02-01T00:00:00Z').getTime())).toMatchObject({
      paying: true,
      priceId: 'growth-m',
    });
    expect(stateAt(t, d('2026-04-01T00:00:00Z').getTime()).paying).toBe(false);
    expect(stateAt(t, d('2026-06-10T00:00:00Z').getTime())).toMatchObject({
      paying: true,
      priceId: 'pro-m',
    });
  });

  it('never assumes a price: no recorded source is incomplete; an unknown price is flagged, not zero', () => {
    const noSource = buildTimeline(
      sub({
        checkouts: [],
        events: [
          ev('PAYMENT_SUCCEEDED', '2026-01-10T00:00:01Z', 'ACTIVE', 'ACTIVE'),
        ],
      }),
    );
    expect(noSource.complete).toBe(false);
    const unknown = buildTimeline(
      sub({
        planPriceId: 'gone',
        checkouts: [
          {
            planPriceId: 'gone',
            completedAt: d('2026-01-10T00:00:00Z'),
            replaces: false,
          },
        ],
        events: [
          ev('PAYMENT_SUCCEEDED', '2026-01-10T00:00:01Z', 'ACTIVE', 'ACTIVE'),
        ],
      }),
    );
    const [feb] = monthWindows('2026-02', '2026-02', d('2026-06-01T00:00:00Z'));
    const month = monthOf(feb, [unknown], prices, [], [], () => 0);
    expect(month).toMatchObject({
      status: 'INCOMPLETE',
      missingPrices: 1,
      partial: false,
      recurring: [],
    });
    const [june] = monthWindows(
      '2026-06',
      '2026-06',
      d('2026-06-15T00:00:00Z'),
    );
    expect(monthOf(june, [], prices, [], [], () => 0).partial).toBe(true);
  });

  it('reports trial cohorts by start month, distinguishing incomplete cohorts', () => {
    const now = d('2026-06-15T00:00:00Z');
    const converted = buildTimeline(
      sub({
        id: 'c',
        events: [
          ev('TRIAL_STARTED', '2026-05-01T00:00:00Z', 'ACTIVE', 'TRIALING'),
          ev('PAYMENT_SUCCEEDED', '2026-05-15T00:00:00Z', 'TRIALING', 'ACTIVE'),
        ],
      }),
    );
    const expired = buildTimeline(
      sub({
        id: 'e',
        status: 'TRIAL_EXPIRED',
        externalSubscriptionId: null,
        currentPeriodStart: null,
        events: [
          ev('TRIAL_STARTED', '2026-05-03T00:00:00Z', 'ACTIVE', 'TRIALING'),
          ev(
            'TRIAL_EXPIRED',
            '2026-05-17T00:00:00Z',
            'TRIALING',
            'TRIAL_EXPIRED',
          ),
        ],
      }),
    );
    const trialing = buildTimeline(
      sub({
        id: 't',
        status: 'TRIALING',
        externalSubscriptionId: null,
        currentPeriodStart: null,
        events: [
          ev('TRIAL_STARTED', '2026-06-05T00:00:00Z', 'ACTIVE', 'TRIALING'),
        ],
      }),
    );
    const windows = monthWindows('2026-05', '2026-06', now);
    expect(
      trialCohorts(windows, [converted, expired, trialing], (id) => id === 'e'),
    ).toEqual([
      // The expired trial can still convert during its recovery window.
      {
        month: '2026-05',
        started: 2,
        converted: 1,
        expired: 1,
        inProgress: 0,
        complete: false,
      },
      {
        month: '2026-06',
        started: 1,
        converted: 0,
        expired: 0,
        inProgress: 1,
        complete: false,
      },
    ]);
    expect(
      trialCohorts(windows.slice(0, 1), [converted, expired], () => false)[0]
        .complete,
    ).toBe(true);
  });

  it('checks accounting invariants', () => {
    const invoice: InvoiceInput = {
      id: 'x',
      status: 'paid',
      currency: 'usd',
      totalMinorUnits: 1000,
      amountDueMinorUnits: 1000,
      amountPaidMinorUnits: 1000,
      balanceAppliedMinorUnits: 0,
      taxMinorUnits: 100,
      totalExcludingTaxMinorUnits: 800,
      attemptCount: 1,
      issuedAt: d('2026-05-01T00:00:00Z'),
      paidAt: d('2026-05-01T00:00:00Z'),
    };
    expect(
      invariantViolations(
        [invoice],
        [
          {
            invoiceId: 'x',
            origin: 'EXTERNAL',
            kind: 'REFUND',
            currency: 'usd',
            totalMinorUnits: 1500,
            finishedAt: d('2026-05-02T00:00:00Z'),
          },
        ],
        [],
        [],
      ),
    ).toEqual([
      { code: 'ADJUSTMENTS_EXCEED_PAID', count: 1 },
      { code: 'INVOICE_AMOUNTS_DONT_ADD_UP', count: 1 },
    ]);
  });

  it('months are UTC calendar months; the current month ends now', () => {
    const now = d('2026-03-15T12:00:00Z');
    expect(
      monthWindows('2025-12', '2026-03', now).map((w) => [
        w.key,
        new Date(w.start).toISOString(),
        new Date(w.end).toISOString(),
      ]),
    ).toEqual([
      ['2025-12', '2025-12-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
      ['2026-01', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'],
      ['2026-02', '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
      ['2026-03', '2026-03-01T00:00:00.000Z', '2026-03-15T12:00:00.000Z'],
    ]);
  });
});
