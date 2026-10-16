import { transition, type BillingState } from './billing-lifecycle';
import {
  eventsFromSnapshot,
  type ProviderSubscriptionSnapshot,
} from './provider-sync';

// SC3b — the provider's live subscription brought into our lifecycle (F3,
// trial safety): a cardless trial that ends is TRIAL EXPIRY (never a
// cancellation, never a charge); an authorized trial converts; a trial we
// never offered is never accepted.
const T0 = new Date('2026-11-01T00:00:00Z');
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

function billed(over: Partial<BillingState> = {}): BillingState {
  return {
    billingMode: 'BILLED',
    status: 'ACTIVE',
    planVersionId: 'v1',
    planPriceId: 'p1',
    recurringPaymentAuthorizedAt: null,
    trialStartedAt: null,
    trialEndsAt: null,
    trialRequiresPaymentMethod: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    pastDueAt: null,
    graceEndsAt: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    pending: null,
    ...over,
  };
}

function snapshot(
  over: Partial<ProviderSubscriptionSnapshot> = {},
): ProviderSubscriptionSnapshot {
  return {
    externalSubscriptionId: 'sub_1',
    externalCustomerId: 'cus_1',
    status: 'trialing',
    livemode: false,
    hasPaymentMethod: false,
    cancelAtPeriodEnd: false,
    trialStart: T0,
    trialEnd: day(14),
    ...over,
  };
}

// Applies the derived events in order (as the service does).
function sync(
  state: BillingState,
  snap: ProviderSubscriptionSnapshot,
  offered = { trialDays: 14, requiresPaymentMethod: false },
) {
  const { events, unexpectedTrial } = eventsFromSnapshot(
    state,
    snap,
    offered,
    day(0),
  );
  let next = state;
  const history: string[] = [];
  const suspensions: string[] = [];
  for (const event of events) {
    const result = transition(next, event);
    if (!result.ok || !result.changed) continue;
    next = result.next;
    history.push(...result.history.map((h) => h.type));
    if (result.suspension !== 'NONE') suspensions.push(result.suspension);
  }
  return { next, history, suspensions, unexpectedTrial };
}

describe('SC3b provider sync', () => {
  it('a cardless trial starts with the provider dates, bounded by what we offered', () => {
    const r = sync(billed(), snapshot());
    expect(r.next).toMatchObject({
      status: 'TRIALING',
      trialStartedAt: T0,
      trialEndsAt: day(14),
      trialRequiresPaymentMethod: false,
      recurringPaymentAuthorizedAt: null,
    });
    expect(r.history).toEqual(['TRIAL_STARTED']);
  });

  it('a cardless trial the provider ended is TRIAL EXPIRY — not a cancellation, and nothing is charged', () => {
    const trialing = sync(billed(), snapshot()).next;
    const r = sync(trialing, snapshot({ status: 'canceled' }));
    expect(r.next.status).toBe('TRIAL_EXPIRED');
    expect(r.next.canceledAt).toBeNull();
    expect(r.history).toEqual(['TRIAL_EXPIRED']);
    expect(r.suspensions).toEqual(['SUSPEND_FOR_BILLING']);
    // Seen again (a later notification): nothing changes, never CANCELED.
    expect(sync(r.next, snapshot({ status: 'canceled' })).history).toEqual([]);
  });

  it('a trial whose start and end arrive together (late delivery) still records trial expiry', () => {
    const r = sync(billed(), snapshot({ status: 'canceled' }));
    expect(r.history).toEqual(['TRIAL_STARTED', 'TRIAL_EXPIRED']);
    expect(r.next.status).toBe('TRIAL_EXPIRED');
  });

  it('an authorized trial converts: authorization first, then the first invoice decides', () => {
    const trialing = sync(billed(), snapshot({ hasPaymentMethod: true }), {
      trialDays: 14,
      requiresPaymentMethod: true,
    });
    expect(trialing.history).toEqual(['PAYMENT_AUTHORIZED', 'TRIAL_STARTED']);
    const converted = sync(
      trialing.next,
      snapshot({ status: 'active', hasPaymentMethod: true }),
    );
    // TRIAL_ENDED with authorization changes nothing; invoice.paid will.
    expect(converted.next.status).toBe('TRIALING');
    expect(converted.history).toEqual([]);
  });

  it('a card added during a cardless trial is recorded as authorization', () => {
    const trialing = sync(billed(), snapshot()).next;
    const r = sync(trialing, snapshot({ hasPaymentMethod: true }));
    expect(r.history).toEqual(['PAYMENT_AUTHORIZED']);
    expect(r.next.recurringPaymentAuthorizedAt).not.toBeNull();
  });

  it('a trial we never offered (or longer than offered) is never accepted', () => {
    const none = eventsFromSnapshot(billed(), snapshot(), null, day(0));
    expect(none.unexpectedTrial).toBe(true);
    expect(none.events.map((e) => e.type)).not.toContain('TRIAL_STARTED');
    const zero = eventsFromSnapshot(
      billed(),
      snapshot(),
      { trialDays: 0, requiresPaymentMethod: true },
      day(0),
    );
    expect(zero.unexpectedTrial).toBe(true);
    // Longer than offered: the lifecycle refuses it.
    expect(sync(billed(), snapshot({ trialEnd: day(30) })).next.status).toBe(
      'ACTIVE',
    );
  });

  it('mirrors a scheduled cancellation and its withdrawal, and an ended paid subscription is CANCELED', () => {
    const active = billed({
      recurringPaymentAuthorizedAt: T0,
      currentPeriodStart: T0,
      currentPeriodEnd: day(30),
    });
    const live = {
      status: 'active' as const,
      hasPaymentMethod: true,
      trialStart: null,
      trialEnd: null,
    };
    const scheduled = sync(
      active,
      snapshot({ ...live, cancelAtPeriodEnd: true }),
    );
    expect(scheduled.history).toEqual(['CANCEL_SCHEDULED']);
    expect(sync(scheduled.next, snapshot({ ...live })).history).toEqual([
      'CANCEL_UNDONE',
    ]);
    const ended = sync(
      scheduled.next,
      snapshot({ ...live, status: 'canceled', cancelAtPeriodEnd: true }),
    );
    expect(ended.next.status).toBe('CANCELED');
    expect(ended.suspensions).toEqual([]);
  });

  it('a live view identical to ours derives nothing (idempotent under redelivery)', () => {
    const trialing = sync(billed(), snapshot()).next;
    expect(
      eventsFromSnapshot(
        trialing,
        snapshot(),
        { trialDays: 14, requiresPaymentMethod: false },
        day(1),
      ).events,
    ).toEqual([]);
  });
});
