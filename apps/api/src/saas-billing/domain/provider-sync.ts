import type { BillingEvent, BillingState } from './billing-lifecycle';

// SC3b — what the provider's CURRENT view of a subscription means for our
// lifecycle (pure). Subscription-change notifications are not applied as
// deltas: the adapter re-reads the live provider subscription and this
// derives the lifecycle events that bring our state in line with it, in a
// safe order. Applying the provider's present state (rather than an event's
// snapshot) is what makes duplicate, delayed and out-of-order delivery
// harmless for these notifications.
//
// Payments are NOT derived here: a payment is only ever recorded from its
// own verified invoice event (PAYMENT_SUCCEEDED / PAYMENT_FAILED).

export type ProviderSubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused';

export type PaymentMethodSource = 'SUBSCRIPTION' | 'CUSTOMER_DEFAULT' | null;

export interface ProviderSubscriptionSnapshot {
  externalSubscriptionId: string;
  externalCustomerId: string;
  status: ProviderSubscriptionStatus;
  livemode: boolean;
  // A payment method the provider will charge automatically.
  hasPaymentMethod: boolean;
  // Where it comes from: the subscription's own default (what Checkout
  // records) or the customer's default (charged when the subscription has
  // none) — both legitimate. null when there is none.
  paymentMethodSource: PaymentMethodSource;
  cancelAtPeriodEnd: boolean;
  trialStart: Date | null;
  trialEnd: Date | null;
  // SC3c-2 — the subscription's most recent invoice (its first one, for a
  // just-created subscription), when the provider reports one.
  latestInvoiceId: string | null;
  // SC3d-1 — what the provider actually bills: its subscription items, the
  // subscription schedule attached (null: none), whether an update is waiting
  // for payment, and when the current period ends. Optional: undefined means
  // "not read", and anything that relies on them fails closed.
  items?: ProviderSubscriptionItem[];
  scheduleId?: string | null;
  hasPendingUpdate?: boolean;
  currentPeriodEnd?: Date | null;
}

export interface ProviderSubscriptionItem {
  externalItemId: string;
  externalPriceId: string | null;
  quantity: number;
}

// What we offered when the business opened Checkout (fixed then): a trial is
// only accepted if WE offered it, for at most that long.
export interface OfferedTrial {
  trialDays: number;
  requiresPaymentMethod: boolean;
}

export interface SnapshotSync {
  events: BillingEvent[];
  // The provider says the subscription is trialing although we offered no
  // trial (or it ran longer than offered): never accepted — reviewed.
  unexpectedTrial: boolean;
}

export function eventsFromSnapshot(
  state: BillingState,
  snapshot: ProviderSubscriptionSnapshot,
  offered: OfferedTrial | null,
  at: Date,
  // SC3c — the billing policy's recovery window for an expired trial.
  trialRecoveryDays: number,
): SnapshotSync {
  const events: BillingEvent[] = [];
  let unexpectedTrial = false;
  const ended =
    snapshot.status === 'canceled' || snapshot.status === 'incomplete_expired';

  // 1. Authorization first: it never removes anything, and a trial that
  //    requires a payment method needs it.
  if (
    snapshot.hasPaymentMethod &&
    state.recurringPaymentAuthorizedAt === null
  ) {
    events.push({ type: 'PAYMENT_AUTHORIZED', at });
  }

  // 2. A trial the provider started, only if we offered one.
  if (
    state.trialStartedAt === null &&
    state.currentPeriodStart === null &&
    snapshot.trialStart !== null &&
    snapshot.trialEnd !== null &&
    (snapshot.status === 'trialing' || ended)
  ) {
    if (offered !== null && offered.trialDays > 0) {
      events.push({
        type: 'TRIAL_STARTED',
        at: snapshot.trialStart,
        trialDays: offered.trialDays,
        requiresPaymentMethod: offered.requiresPaymentMethod,
        endsAt: snapshot.trialEnd,
      });
    } else {
      unexpectedTrial = true;
    }
  }

  // 3. A scheduled cancellation set or withdrawn (only while it runs).
  if (!ended && snapshot.cancelAtPeriodEnd !== state.cancelAtPeriodEnd) {
    events.push({
      type: snapshot.cancelAtPeriodEnd ? 'CANCEL_SCHEDULED' : 'CANCEL_UNDONE',
      at,
    });
  }

  // 4. The trial is over (the first invoice then decides, if authorized).
  if (
    state.status === 'TRIALING' &&
    (snapshot.status === 'active' ||
      snapshot.status === 'past_due' ||
      snapshot.status === 'unpaid')
  ) {
    events.push({ type: 'TRIAL_ENDED', at, trialRecoveryDays });
  }

  // 5. The subscription ended (a cardless trial that ran out is recorded as
  //    trial expiry by the lifecycle, not as a cancellation).
  if (ended) {
    events.push({ type: 'SUBSCRIPTION_ENDED', at, trialRecoveryDays });
  }

  return { events, unexpectedTrial };
}
