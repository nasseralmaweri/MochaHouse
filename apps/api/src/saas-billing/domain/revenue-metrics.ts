import type {
  RevenueAdjustmentTotal,
  RevenueCash,
  RevenueMonth,
  RevenuePlanBreakdown,
  RevenueRecurring,
  RevenueTrialCohort,
} from '@mocha-house/contracts';

// SC3f — CENTERIVO SaaS revenue metrics (owner decisions D1, D3, D4, D6),
// pure: no database, no clock (the caller passes `now`). Every amount stays
// in its own currency, in integer minor units.
//
// Contracted recurring revenue (D1) from each PAYING subscription's actual
// subscribed price version: monthly as agreed, annual / 12. ARR is summed
// exactly (monthly x 12 + annual); MRR = ARR / 12, rounded once per total —
// never per subscription, so nothing accumulates.
//
// History (D3) is rebuilt from the append-only subscription events, the
// completed checkouts (the price a subscription started or restarted on)
// and the complimentary grants. A rebuilt history that doesn't end in the
// subscription's current record is INCOMPLETE: it is still counted where
// known, and every month it touches is flagged — never filled in.

export type Interval = 'MONTH' | 'YEAR';

export interface PriceInfo {
  id: string;
  planName: string;
  interval: Interval;
  currency: string; // lower case
  amountMinorUnits: number;
}

export interface SubscriptionEventInput {
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  planPriceId: string | null;
  at: Date;
}

export interface SubscriptionInput {
  id: string;
  createdAt: Date;
  billingMode: 'BILLED' | 'COMPLIMENTARY';
  status: string;
  planPriceId: string | null;
  externalSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  recoveryEndsAt: Date | null;
  // Ascending by time.
  events: SubscriptionEventInput[];
  // Completed checkouts, ascending.
  checkouts: { planPriceId: string; completedAt: Date; replaces: boolean }[];
  grants: {
    status: string;
    previousPlanPriceId: string;
    startedAt: Date | null;
    finishedAt: Date | null;
  }[];
}

export interface Segment {
  from: number; // ms
  paying: boolean;
  status: string | null;
  priceId: string | null;
}

export interface Ending {
  at: number;
  kind: 'CANCELED' | 'COMPLIMENTARY';
  fromStatus: string | null;
  priceId: string | null;
}

export interface Timeline {
  subscriptionId: string;
  segments: Segment[]; // ascending; each lasts until the next one
  endings: Ending[];
  trialStartedAt: number | null;
  trialOutcome: 'CONVERTED' | 'EXPIRED' | 'IN_PROGRESS' | null;
  complete: boolean;
  firstActivity: number;
}

const PAYING_STATUSES = new Set(['ACTIVE', 'PAST_DUE']);
const MOVED_TO_COMPLIMENTARY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Paying NOW, from the subscription's own record: billed, active or past
// due, with a provider subscription and a paid period.
export function payingNow(sub: SubscriptionInput): boolean {
  return (
    sub.billingMode === 'BILLED' &&
    PAYING_STATUSES.has(sub.status) &&
    sub.externalSubscriptionId !== null &&
    sub.currentPeriodStart !== null &&
    sub.planPriceId !== null
  );
}

export function buildTimeline(sub: SubscriptionInput): Timeline {
  let complete = true;
  // The price comes only from recorded sources: every completed checkout
  // (billing started or restarted on that price), recorded plan changes,
  // replacements and the end of a complimentary arrangement. Never assumed
  // from the current record: a payment with no known price is incomplete.
  let price: string | null = null;
  const stream = [
    ...sub.events,
    ...sub.checkouts
      .filter((c) => !c.replaces)
      .map((c) => ({
        type: 'CHECKOUT_COMPLETED',
        fromStatus: null,
        toStatus: null,
        planPriceId: c.planPriceId,
        at: c.completedAt,
      })),
  ].sort(
    (a, b) =>
      a.at.getTime() - b.at.getTime() ||
      // A checkout's price applies before an event at the same instant.
      (a.type === 'CHECKOUT_COMPLETED' ? -1 : 0) -
        (b.type === 'CHECKOUT_COMPLETED' ? -1 : 0),
  );
  let status: string | null = null;
  let mode: 'BILLED' | 'COMPLIMENTARY' = 'BILLED';
  let paid = false;
  const usedCheckouts = new Set<number>();
  const segments: Segment[] = [
    {
      from: Number.NEGATIVE_INFINITY,
      paying: false,
      status: null,
      priceId: price,
    },
  ];
  const endings: Ending[] = [];
  let trialStartedAt: number | null = null;
  let converted = false;
  let expired = false;
  const isPaying = () =>
    mode === 'BILLED' && paid && status !== null && PAYING_STATUSES.has(status);

  for (const event of stream) {
    const at = event.at.getTime();
    const wasPaid = paid && mode === 'BILLED';
    const wasStatus = status;
    const wasPrice = price;
    if (event.toStatus !== null) status = event.toStatus;
    switch (event.type) {
      case 'CHECKOUT_COMPLETED':
        price = event.planPriceId;
        break;
      case 'TRIAL_STARTED':
        if (trialStartedAt === null) trialStartedAt = at;
        break;
      case 'PAYMENT_SUCCEEDED':
        paid = true;
        if (trialStartedAt !== null) converted = true;
        if (price === null) complete = false;
        break;
      case 'TRIAL_EXPIRED':
        paid = false;
        if (trialStartedAt !== null && !converted) expired = true;
        break;
      case 'PLAN_CHANGE_APPLIED':
        if (event.planPriceId !== null) price = event.planPriceId;
        else complete = false;
        break;
      case 'SUBSCRIPTION_REPLACED': {
        paid = false;
        const index = sub.checkouts.findIndex(
          (c, i) =>
            c.replaces &&
            !usedCheckouts.has(i) &&
            c.completedAt.getTime() <= at + 60_000,
        );
        if (index >= 0) {
          usedCheckouts.add(index);
          price = sub.checkouts[index].planPriceId;
        } else {
          price = null;
          complete = false;
        }
        break;
      }
      case 'COMPLIMENTARY_STARTED':
        mode = 'COMPLIMENTARY';
        paid = false;
        break;
      case 'COMPLIMENTARY_ENDED':
        mode = 'BILLED';
        paid = false;
        price = event.planPriceId;
        break;
      case 'CANCELED':
        paid = false;
        if (trialStartedAt !== null && !converted) expired = true;
        break;
      default:
        break;
    }
    // A paid subscription that actually ended (from active, past due or
    // unpaid, after it had been paid).
    if (
      (event.type === 'CANCELED' || event.type === 'COMPLIMENTARY_STARTED') &&
      wasPaid &&
      wasStatus !== null &&
      ['ACTIVE', 'PAST_DUE', 'UNPAID'].includes(wasStatus)
    ) {
      {
        endings.push({
          at,
          kind: event.type === 'CANCELED' ? 'CANCELED' : 'COMPLIMENTARY',
          fromStatus: wasStatus,
          priceId: wasPrice,
        });
      }
    }
    segments.push({ from: at, paying: isPaying(), status, priceId: price });
  }

  // A cancellation followed by a complimentary arrangement starting is a move
  // to complimentary, not churn.
  for (const ending of endings) {
    if (
      ending.kind === 'CANCELED' &&
      sub.grants.some(
        (g) =>
          g.startedAt !== null &&
          g.startedAt.getTime() >= ending.at &&
          g.startedAt.getTime() - ending.at <= MOVED_TO_COMPLIMENTARY_WINDOW_MS,
      )
    ) {
      ending.kind = 'COMPLIMENTARY';
    }
  }

  // The rebuilt history must end where the subscription's record is: paying
  // or not, at the same price, status and billing mode.
  const last = segments[segments.length - 1];
  const now = payingNow(sub);
  if (
    last.paying !== now ||
    (now && last.priceId !== sub.planPriceId) ||
    (status !== null &&
      sub.billingMode === 'BILLED' &&
      status !== sub.status) ||
    mode !== sub.billingMode
  ) {
    complete = false;
  }

  let trialOutcome: Timeline['trialOutcome'] = null;
  if (trialStartedAt !== null) {
    trialOutcome = converted
      ? 'CONVERTED'
      : expired || status === 'CANCELED'
        ? 'EXPIRED'
        : 'IN_PROGRESS';
  }
  return {
    subscriptionId: sub.id,
    segments,
    endings,
    trialStartedAt,
    trialOutcome,
    complete,
    firstActivity: Math.min(
      sub.createdAt.getTime(),
      sub.events[0]?.at.getTime() ?? Number.POSITIVE_INFINITY,
    ),
  };
}

// The segment in force at `at` (ms).
export function stateAt(timeline: Timeline, at: number): Segment {
  let found = timeline.segments[0];
  for (const segment of timeline.segments) {
    if (segment.from <= at) found = segment;
    else break;
  }
  return found;
}

// --- recurring revenue --------------------------------------------------------------

interface RecurringAccumulator {
  arr: number;
  atRiskArr: number;
  active: number;
  atRisk: number;
  monthly: number;
  annual: number;
}

export function annualMinorUnits(price: PriceInfo): number {
  return price.interval === 'YEAR'
    ? price.amountMinorUnits
    : price.amountMinorUnits * 12;
}

// MRR from exact ARR, rounded once (half up).
export function mrrOf(arrMinorUnits: number): number {
  return Math.floor((arrMinorUnits + 6) / 12);
}

export function recurringOf(
  paying: { priceId: string; status: string }[],
  prices: Map<string, PriceInfo>,
): {
  recurring: RevenueRecurring[];
  byPlan: RevenuePlanBreakdown[];
  missingPrices: number;
} {
  const byCurrency = new Map<string, RecurringAccumulator>();
  const byPlan = new Map<string, RevenuePlanBreakdown & { arr: number }>();
  let missingPrices = 0;
  for (const item of paying) {
    const price = prices.get(item.priceId);
    if (!price) {
      missingPrices++;
      continue;
    }
    const arr = annualMinorUnits(price);
    const acc = byCurrency.get(price.currency) ?? {
      arr: 0,
      atRiskArr: 0,
      active: 0,
      atRisk: 0,
      monthly: 0,
      annual: 0,
    };
    acc.arr += arr;
    acc.active++;
    if (item.status === 'PAST_DUE') {
      acc.atRiskArr += arr;
      acc.atRisk++;
    }
    if (price.interval === 'YEAR') acc.annual++;
    else acc.monthly++;
    byCurrency.set(price.currency, acc);
    const key = `${price.planName}\u0000${price.interval}\u0000${price.currency}`;
    const plan = byPlan.get(key) ?? {
      planName: price.planName,
      interval: price.interval,
      currency: price.currency.toUpperCase(),
      subscriptions: 0,
      mrrMinorUnits: 0,
      arrMinorUnits: 0,
      arr: 0,
    };
    plan.subscriptions++;
    plan.arr += arr;
    byPlan.set(key, plan);
  }
  return {
    recurring: [...byCurrency.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, acc]) => ({
        currency: currency.toUpperCase(),
        mrrMinorUnits: mrrOf(acc.arr),
        arrMinorUnits: acc.arr,
        atRiskMrrMinorUnits: mrrOf(acc.atRiskArr),
        activePaidSubscriptions: acc.active,
        atRiskSubscriptions: acc.atRisk,
        monthlySubscriptions: acc.monthly,
        annualSubscriptions: acc.annual,
      })),
    byPlan: [...byPlan.values()]
      .sort(
        (a, b) =>
          a.currency.localeCompare(b.currency) ||
          a.planName.localeCompare(b.planName) ||
          a.interval.localeCompare(b.interval),
      )
      .map(({ arr, ...plan }) => ({
        ...plan,
        arrMinorUnits: arr,
        mrrMinorUnits: mrrOf(arr),
      })),
    missingPrices,
  };
}

// --- months --------------------------------------------------------------------------

export interface MonthWindow {
  key: string; // YYYY-MM
  start: number;
  end: number; // exclusive; for the current month, `now`
}

// The calendar end of a month window (its end may be "now").
function monthEndOf(window: MonthWindow): number {
  const start = new Date(window.start);
  return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
}

export function monthWindows(
  from: string,
  to: string,
  now: Date,
): MonthWindow[] {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const windows: MonthWindow[] = [];
  for (
    let y = fy, m = fm;
    y < ty || (y === ty && m <= tm);
    m === 12 ? (y++, (m = 1)) : m++
  ) {
    const start = Date.UTC(y, m - 1, 1);
    const end = Math.min(Date.UTC(y, m, 1), now.getTime());
    windows.push({ key: `${y}-${String(m).padStart(2, '0')}`, start, end });
  }
  return windows;
}

export interface InvoiceInput {
  id: string;
  status: string;
  currency: string;
  totalMinorUnits: number;
  amountDueMinorUnits: number;
  amountPaidMinorUnits: number;
  balanceAppliedMinorUnits: number;
  taxMinorUnits: number | null;
  totalExcludingTaxMinorUnits: number | null;
  attemptCount: number | null;
  issuedAt: Date;
  paidAt: Date | null;
}

export interface AdjustmentInput {
  invoiceId: string;
  origin: 'CENTERIVO' | 'EXTERNAL';
  kind: 'REFUND' | 'CREDIT' | 'OUT_OF_BAND';
  currency: string;
  totalMinorUnits: number;
  finishedAt: Date;
}

// An invoice that had at least one failed payment attempt (counted once,
// however many retries): paid only on a later attempt, or attempted and
// never paid. Null: the attempts aren't known (not counted, reported).
export function invoiceFailed(invoice: InvoiceInput): boolean | null {
  if (invoice.status === 'draft') return false;
  if (invoice.attemptCount === null) return null;
  if (invoice.status === 'paid') return invoice.attemptCount > 1;
  return invoice.attemptCount >= 1;
}

const within = (date: Date | null, window: MonthWindow) =>
  date !== null &&
  date.getTime() >= window.start &&
  date.getTime() < window.end;

export function cashOf(
  window: MonthWindow,
  invoices: InvoiceInput[],
  adjustments: AdjustmentInput[],
): {
  cash: RevenueCash[];
  failed: RevenueMonth['failedInvoices'];
  recovered: number;
} {
  const byCurrency = new Map<string, RevenueCash & { taxKnown: boolean }>();
  const of = (currency: string) => {
    const key = currency.toLowerCase();
    let entry = byCurrency.get(key);
    if (!entry) {
      entry = {
        currency: key.toUpperCase(),
        collectedMinorUnits: 0,
        taxMinorUnits: 0,
        refundsMinorUnits: 0,
        refundsOutsideProviderMinorUnits: 0,
        creditsIssuedMinorUnits: 0,
        balanceAppliedMinorUnits: 0,
        recoveredMinorUnits: 0,
        taxKnown: true,
      };
      byCurrency.set(key, entry);
    }
    return entry;
  };
  const failedDue = new Map<string, number>();
  let failedCount = 0;
  let unverified = 0;
  let recovered = 0;
  for (const invoice of invoices) {
    if (invoice.status === 'paid' && within(invoice.paidAt, window)) {
      const entry = of(invoice.currency);
      entry.collectedMinorUnits += invoice.amountPaidMinorUnits;
      if (invoice.taxMinorUnits === null) entry.taxKnown = false;
      else entry.taxMinorUnits! += invoice.taxMinorUnits;
      if (invoiceFailed(invoice) === true) {
        entry.recoveredMinorUnits += invoice.amountPaidMinorUnits;
        recovered++;
      }
    }
    if (within(invoice.issuedAt, window) && invoice.status !== 'draft') {
      if (invoice.status !== 'void') {
        of(invoice.currency).balanceAppliedMinorUnits +=
          invoice.balanceAppliedMinorUnits;
      }
      const failed = invoiceFailed(invoice);
      if (failed === null) unverified++;
      else if (failed) {
        failedCount++;
        const key = invoice.currency.toUpperCase();
        failedDue.set(
          key,
          (failedDue.get(key) ?? 0) + invoice.amountDueMinorUnits,
        );
      }
    }
  }
  for (const adjustment of adjustments) {
    if (!within(adjustment.finishedAt, window)) continue;
    const entry = of(adjustment.currency);
    if (adjustment.kind === 'CREDIT')
      entry.creditsIssuedMinorUnits += adjustment.totalMinorUnits;
    else if (adjustment.kind === 'OUT_OF_BAND') {
      entry.refundsOutsideProviderMinorUnits += adjustment.totalMinorUnits;
    } else entry.refundsMinorUnits += adjustment.totalMinorUnits;
  }
  return {
    cash: [...byCurrency.values()]
      .sort((a, b) => a.currency.localeCompare(b.currency))
      .map(({ taxKnown, ...entry }) => ({
        ...entry,
        taxMinorUnits: taxKnown ? entry.taxMinorUnits : null,
      })),
    failed: {
      count: failedCount,
      amountDue: [...failedDue.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, minorUnits]) => ({ currency, minorUnits })),
      unverified,
    },
    recovered,
  };
}

export function monthOf(
  window: MonthWindow,
  timelines: Timeline[],
  prices: Map<string, PriceInfo>,
  invoices: InvoiceInput[],
  adjustments: AdjustmentInput[],
  complimentaryAt: (at: number) => number,
): RevenueMonth {
  const atStart: { priceId: string; status: string; id: string }[] = [];
  const atEnd: { priceId: string; status: string }[] = [];
  let incomplete = false;
  let missingStart = 0;
  let missingEnd = 0;
  let missingChurned = 0;
  const endAt = window.end - 1;
  for (const timeline of timelines) {
    const startState = stateAt(timeline, window.start - 1);
    const endState = stateAt(timeline, endAt);
    // Paying, at a price that can't be found: never counted as zero —
    // flagged.
    const known = (state: { priceId: string | null }) =>
      state.priceId !== null && prices.has(state.priceId);
    if (startState.paying && !known(startState)) missingStart++;
    if (endState.paying && !known(endState)) missingEnd++;
    if (startState.paying && startState.priceId) {
      atStart.push({
        priceId: startState.priceId,
        status: startState.status ?? 'ACTIVE',
        id: timeline.subscriptionId,
      });
    }
    if (endState.paying && endState.priceId) {
      atEnd.push({
        priceId: endState.priceId,
        status: endState.status ?? 'ACTIVE',
      });
    }
    if (!timeline.complete && timeline.firstActivity < window.end)
      incomplete = true;
  }
  const startIds = new Set(atStart.map((s) => s.id));
  let ended = 0;
  let endedOther = 0;
  let moved = 0;
  const churned = new Map<string, number>();
  for (const timeline of timelines) {
    for (const ending of timeline.endings) {
      if (ending.at < window.start || ending.at >= window.end) continue;
      if (ending.kind === 'COMPLIMENTARY') {
        moved++;
        continue;
      }
      const counted =
        startIds.has(timeline.subscriptionId) && ending.fromStatus !== 'UNPAID';
      if (!counted) {
        endedOther++;
        continue;
      }
      ended++;
      const price = ending.priceId ? prices.get(ending.priceId) : undefined;
      if (price) {
        churned.set(
          price.currency,
          (churned.get(price.currency) ?? 0) + annualMinorUnits(price),
        );
      } else {
        missingChurned++;
      }
    }
  }
  const startRecurring = recurringOf(atStart, prices);
  const endRecurring = recurringOf(atEnd, prices);
  const currencies = new Set([
    ...startRecurring.recurring.map((r) => r.currency.toLowerCase()),
    ...churned.keys(),
  ]);
  const startArr = (currency: string) =>
    startRecurring.recurring.find((r) => r.currency.toLowerCase() === currency)
      ?.arrMinorUnits ?? 0;
  const { cash, failed, recovered } = cashOf(window, invoices, adjustments);
  const missingPrices = Math.max(missingStart, missingEnd) + missingChurned;
  return {
    month: window.key,
    status: incomplete || missingPrices > 0 ? 'INCOMPLETE' : 'COMPLETE',
    partial: window.end < monthEndOf(window),
    missingPrices,
    recurring: endRecurring.recurring,
    activePaidAtStart: atStart.length,
    activePaidAtEnd: atEnd.length,
    churn: {
      ended,
      endedOther,
      movedToComplimentary: moved,
      revenue: [...currencies].sort().map((currency) => ({
        currency: currency.toUpperCase(),
        startMrrMinorUnits: mrrOf(startArr(currency)),
        churnedMrrMinorUnits: mrrOf(churned.get(currency) ?? 0),
      })),
    },
    cash,
    failedInvoices: failed,
    recoveredInvoices: recovered,
    complimentaryAtEnd: complimentaryAt(endAt),
  };
}

// --- trials and adjustments -----------------------------------------------------------

export function trialCohorts(
  windows: MonthWindow[],
  timelines: Timeline[],
  recoveryOpen: (subscriptionId: string) => boolean,
): RevenueTrialCohort[] {
  return windows.map((window) => {
    const cohort = timelines.filter(
      (t) =>
        t.trialStartedAt !== null &&
        t.trialStartedAt >= window.start &&
        t.trialStartedAt < window.end,
    );
    const converted = cohort.filter(
      (t) => t.trialOutcome === 'CONVERTED',
    ).length;
    const expired = cohort.filter((t) => t.trialOutcome === 'EXPIRED').length;
    const inProgress = cohort.length - converted - expired;
    // An expired trial can still convert while its recovery window is open.
    const stillOpen = cohort.some(
      (t) => t.trialOutcome === 'EXPIRED' && recoveryOpen(t.subscriptionId),
    );
    return {
      month: window.key,
      started: cohort.length,
      converted,
      expired,
      inProgress,
      complete: inProgress === 0 && !stillOpen,
    };
  });
}

export function adjustmentTotals(
  adjustments: AdjustmentInput[],
  from: number,
  to: number,
): RevenueAdjustmentTotal[] {
  const totals = new Map<string, RevenueAdjustmentTotal>();
  for (const adjustment of adjustments) {
    const at = adjustment.finishedAt.getTime();
    if (at < from || at >= to) continue;
    const key = `${adjustment.currency}|${adjustment.kind}|${adjustment.origin}`;
    const entry = totals.get(key) ?? {
      currency: adjustment.currency.toUpperCase(),
      kind: adjustment.kind,
      origin: adjustment.origin,
      count: 0,
      totalMinorUnits: 0,
    };
    entry.count++;
    entry.totalMinorUnits += adjustment.totalMinorUnits;
    totals.set(key, entry);
  }
  return [...totals.values()].sort(
    (a, b) =>
      a.currency.localeCompare(b.currency) ||
      a.kind.localeCompare(b.kind) ||
      a.origin.localeCompare(b.origin),
  );
}

// --- accounting invariants --------------------------------------------------------------

export function invariantViolations(
  invoices: InvoiceInput[],
  adjustments: AdjustmentInput[],
  recurringTotal: RevenueRecurring[],
  byPlan: RevenuePlanBreakdown[],
): { code: string; count: number }[] {
  const violations = new Map<string, number>();
  const add = (code: string) =>
    violations.set(code, (violations.get(code) ?? 0) + 1);
  for (const invoice of invoices) {
    if (
      invoice.taxMinorUnits !== null &&
      invoice.totalExcludingTaxMinorUnits !== null &&
      invoice.totalExcludingTaxMinorUnits + invoice.taxMinorUnits !==
        invoice.totalMinorUnits
    ) {
      add('INVOICE_AMOUNTS_DONT_ADD_UP');
    }
    if (
      invoice.amountPaidMinorUnits > invoice.totalMinorUnits &&
      invoice.totalMinorUnits >= 0
    ) {
      add('INVOICE_PAID_MORE_THAN_TOTAL');
    }
  }
  const adjusted = new Map<string, number>();
  for (const adjustment of adjustments) {
    adjusted.set(
      adjustment.invoiceId,
      (adjusted.get(adjustment.invoiceId) ?? 0) + adjustment.totalMinorUnits,
    );
  }
  const paidById = new Map(
    invoices.map((invoice) => [invoice.id, invoice.amountPaidMinorUnits]),
  );
  for (const [invoiceId, total] of adjusted) {
    const paid = paidById.get(invoiceId);
    if (paid !== undefined && total > paid) add('ADJUSTMENTS_EXCEED_PAID');
  }
  for (const total of recurringTotal) {
    const plans = byPlan.filter((p) => p.currency === total.currency);
    if (
      plans.reduce((sum, p) => sum + p.arrMinorUnits, 0) !==
        total.arrMinorUnits ||
      plans.reduce((sum, p) => sum + p.subscriptions, 0) !==
        total.activePaidSubscriptions
    ) {
      add('PLAN_BREAKDOWN_MISMATCH');
    }
  }
  return [...violations.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, count]) => ({ code, count }));
}
