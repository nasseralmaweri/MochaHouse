import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { ProviderSubscriptionSnapshot } from '../domain/provider-sync';
import {
  BillingEventVerificationError,
  SaasBillingProviderError,
  type ProviderChargePreview,
  type ProviderCheckoutSession,
  type ProviderInvoice,
  type ProviderPriceChangeResult,
  type ProviderRecurringPreview,
  type ProviderSchedule,
  type ProviderInvoiceRecord,
  type ProviderAdjustableInvoice,
  type ProviderCreditNote,
  type ProviderCreditNoteInput,
  type ProviderRefund,
  type ProviderPaymentMethodSummary,
  type ProviderInvoiceStatus,
  type ProviderPayableInvoice,
  type ProviderLifecycleEvent,
  type SaasBillingProvider,
  type VerifiedBillingProviderEvent,
} from './saas-billing-provider';
import type { ProviderPortalConfiguration } from './portal-configuration';

// SC3a/SC3b — a deterministic, in-memory SaaS billing provider for
// development and tests ONLY (refused in production-like environments; see
// saas-billing-provider-mode.ts). It moves no money and calls nothing.
//
// Events are signed like a real provider's webhooks so the verification
// path is exercised end to end:
//   header  "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}`>"
//   body    {"id","type","created","livemode","data":{...}}
// Operations are idempotent by key (or deterministic by our ids): repeating
// one returns the first result, never a second object. Tests drive the
// provider side through the helpers at the bottom (complete a Checkout,
// change a subscription, settle an invoice).

export const FAKE_SIGNATURE_TOLERANCE_SECONDS = 300;

export type FakeEventType =
  | 'payment_method.authorized'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'subscription.trial_ended'
  | 'subscription.cancel_scheduled'
  | 'subscription.cancel_undone'
  | 'subscription.ended'
  | 'checkout.completed'
  | 'subscription.changed'
  // SC3e-1 — an invoice changed (or a credit note was issued on it).
  | 'invoice.changed'
  // SC3e-3 — a refund on a payment (data.reference = the payment intent).
  | 'refund.changed';

export interface FakeEventBody {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: {
    subscription?: string | null;
    customer?: string | null;
    // Metadata — never trusted, only cross-checked.
    tenantId?: string | null;
    reference?: string | null;
    session?: string | null;
    amount?: number | null;
    currency?: string | null;
    periodStart?: number | null;
    periodEnd?: number | null;
  };
}

function sign(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

function parseHeader(
  header: string | undefined,
): { timestamp: number; signatures: string[] } | null {
  if (typeof header !== 'string' || header.length > 1000) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't' && value && /^\d{1,12}$/.test(value)) {
      timestamp = Number(value);
    } else if (key === 'v1' && value && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(value);
    }
  }
  return timestamp === null || signatures.length === 0
    ? null
    : { timestamp, signatures };
}

// 2000-01-01 .. 9999: anything else is not a real time.
function toDate(seconds: unknown): Date | null {
  return typeof seconds === 'number' &&
    Number.isInteger(seconds) &&
    seconds >= 946_684_800 &&
    seconds <= 253_402_300_799
    ? new Date(seconds * 1000)
    : null;
}

function optionalText(value: unknown, max = 255): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : null;
}

const hex = () => randomBytes(8).toString('hex');

interface FakeCheckout extends ProviderCheckoutSession {
  externalPriceId: string;
  trialDays: number;
  requiresPaymentMethod: boolean;
}

export class FakeSaasBillingProvider implements SaasBillingProvider {
  readonly name = 'fake';
  readonly livemode = false;
  readonly available = true;
  readonly products = new Map<string, string>();
  readonly prices = new Map<string, string>();
  private readonly customers = new Map<string, string>();
  readonly checkouts = new Map<string, FakeCheckout>();
  private readonly checkoutsByKey = new Map<string, string>();
  readonly subscriptions = new Map<string, ProviderSubscriptionSnapshot>();
  readonly invoices = new Map<string, ProviderPayableInvoice>();
  // SC3e-1 — what an invoice's history record adds (tests set periods,
  // credits, numbers, a different subscription or customer...).
  readonly invoiceDetails = new Map<string, Partial<ProviderInvoiceRecord>>();
  // SC3e-1 — the payment method shown for a subscription (default: a test
  // Visa ending 4242 when the subscription has a payment method).
  readonly paymentMethods = new Map<
    string,
    Pick<ProviderPaymentMethodSummary, 'type' | 'card'>
  >();
  // SC3d-1 — the provider's prices (amount, currency, interval), the
  // subscription schedules it holds, and test hooks for plan changes.
  readonly priceCatalog = new Map<
    string,
    { amountMinorUnits: number; currency: string; interval: 'MONTH' | 'YEAR' }
  >();
  readonly schedules = new Map<
    string,
    {
      externalSubscriptionId: string;
      fromExternalPriceId: string;
      toExternalPriceId: string;
      status: 'active' | 'released' | 'canceled' | 'completed';
      switchAt?: Date | null;
    }
  >();
  private readonly changeResults = new Map<string, ProviderPriceChangeResult>();
  // SC3d-2 — immediate changes waiting for payment (Stripe's pending update).
  readonly pendingChanges = new Map<
    string,
    {
      externalItemId: string;
      toExternalPriceId: string;
      externalInvoiceId: string;
      at: Date;
    }
  >();
  private readonly schedulesByKey = new Map<string, string>();
  // Test hooks: adjust the next preview (tax, discount, a different charge);
  // make the next immediate change's payment fail (pending update).
  previewAdjust: Partial<ProviderChargePreview> | null = null;
  // Test hook: the next change's invoice collects this amount instead.
  paidAdjust: number | null = null;
  failNextChangePayment = false;
  // SC3c-2 — the Customer Portal (test settings; a safe configuration by
  // default, changeable by tests).
  portalConfigurationId: string | null = 'bpc_fake00000001';
  expectedAccountId: string | null = 'acct_fake00000001';
  portalConfiguration: ProviderPortalConfiguration = {
    configurationId: 'bpc_fake00000001',
    accountId: 'acct_fake00000001',
    livemode: false,
    active: true,
    paymentMethodUpdate: true,
    invoiceHistory: true,
    subscriptionCancel: false,
    subscriptionUpdate: false,
    customerUpdate: false,
    loginPage: false,
    otherEnabledFeatures: [],
  };
  readonly portalSessions: Array<{ customer: string; returnUrl: string }> = [];
  // Test hook: open invoices the provider lists for a subscription but whose
  // shape names no subscription (an invoice the adapter could not read).
  readonly unreadableOpenInvoices = new Map<string, ProviderPayableInvoice[]>();
  readonly calls: Array<{ op: string; key: string }> = [];
  // Test hook: make the next provider call fail (a transient outage).
  failNext: string | null = null;
  // SC3d-2 — make the next call of ONE operation fail (e.g. an interrupted
  // plan change submission).
  failOp: { op: string; code: string } | null = null;

  constructor(
    private readonly webhookSecret: string = randomBytes(32).toString('hex'),
  ) {
    if (webhookSecret.length < 32) {
      throw new Error('The fake billing webhook secret is too short.');
    }
  }

  private call(op: string, key: string): void {
    this.calls.push({ op, key });
    if (this.failOp !== null && this.failOp.op === op) {
      const code = this.failOp.code;
      this.failOp = null;
      throw new SaasBillingProviderError(code);
    }
    if (this.failNext !== null) {
      const code = this.failNext;
      this.failNext = null;
      throw new SaasBillingProviderError(code);
    }
  }

  ensureProduct(input: {
    planId: string;
  }): Promise<{ externalProductId: string }> {
    this.call('ensureProduct', input.planId);
    const productId = `fake_prod_${input.planId}`;
    this.products.set(input.planId, productId);
    return Promise.resolve({ externalProductId: productId });
  }

  ensurePrice(input: {
    priceId: string;
    amountMinorUnits?: number;
    currency?: string;
    interval?: 'MONTH' | 'YEAR';
  }): Promise<{ externalPriceId: string }> {
    this.call('ensurePrice', input.priceId);
    const existing = this.prices.get(input.priceId);
    const priceId = existing ?? `fake_price_${hex()}`;
    this.prices.set(input.priceId, priceId);
    if (
      input.amountMinorUnits !== undefined &&
      input.currency &&
      input.interval
    ) {
      this.priceCatalog.set(priceId, {
        amountMinorUnits: input.amountMinorUnits,
        currency: input.currency.toLowerCase(),
        interval: input.interval,
      });
    }
    return Promise.resolve({ externalPriceId: priceId });
  }

  createCustomer(input: {
    idempotencyKey: string;
  }): Promise<{ externalCustomerId: string }> {
    this.call('createCustomer', input.idempotencyKey);
    const existing = this.customers.get(input.idempotencyKey);
    const customerId = existing ?? `fake_cus_${hex()}`;
    this.customers.set(input.idempotencyKey, customerId);
    return Promise.resolve({ externalCustomerId: customerId });
  }

  createCheckoutSession(input: {
    idempotencyKey: string;
    externalCustomerId: string;
    externalPriceId: string;
    trialDays: number;
    requiresPaymentMethod: boolean;
  }): Promise<ProviderCheckoutSession> {
    this.call('createCheckoutSession', input.idempotencyKey);
    const existing = this.checkoutsByKey.get(input.idempotencyKey);
    if (existing) return Promise.resolve(this.view(existing));
    const sessionId = `fake_cs_${hex()}`;
    this.checkouts.set(sessionId, {
      externalSessionId: sessionId,
      status: 'open',
      url: `https://checkout.fake.test/${sessionId}`,
      expiresAt: new Date(Date.now() + 24 * 3600_000),
      externalCustomerId: input.externalCustomerId,
      externalSubscriptionId: null,
      livemode: false,
      externalPriceId: input.externalPriceId,
      trialDays: input.trialDays,
      requiresPaymentMethod: input.requiresPaymentMethod,
    });
    this.checkoutsByKey.set(input.idempotencyKey, sessionId);
    return Promise.resolve(this.view(sessionId));
  }

  private view(sessionId: string): ProviderCheckoutSession {
    const c = this.checkouts.get(sessionId)!;
    return {
      externalSessionId: c.externalSessionId,
      status: c.status,
      url: c.status === 'open' ? c.url : null,
      expiresAt: c.expiresAt,
      externalCustomerId: c.externalCustomerId,
      externalSubscriptionId: c.externalSubscriptionId,
      livemode: false,
    };
  }

  retrieveCheckoutSession(
    externalSessionId: string,
  ): Promise<ProviderCheckoutSession> {
    this.call('retrieveCheckoutSession', externalSessionId);
    if (!this.checkouts.has(externalSessionId)) {
      return Promise.reject(new SaasBillingProviderError('resource_missing'));
    }
    return Promise.resolve(this.view(externalSessionId));
  }

  retrieveSubscription(
    externalSubscriptionId: string,
  ): Promise<ProviderSubscriptionSnapshot> {
    this.call('retrieveSubscription', externalSubscriptionId);
    const snapshot = this.subscriptions.get(externalSubscriptionId);
    return snapshot
      ? Promise.resolve({ ...snapshot })
      : Promise.reject(new SaasBillingProviderError('resource_missing'));
  }

  retrieveInvoice(externalInvoiceId: string): Promise<ProviderInvoice | null> {
    this.call('retrieveInvoice', externalInvoiceId);
    const invoice = this.invoices.get(externalInvoiceId);
    return Promise.resolve(
      invoice ? { ...invoice, record: this.invoiceRecord(invoice) } : null,
    );
  }

  listInvoices(
    externalSubscriptionId: string,
  ): Promise<ProviderInvoiceRecord[]> {
    this.call('listInvoices', externalSubscriptionId);
    return Promise.resolve(
      [...this.invoices.values()]
        .map((invoice) => this.invoiceRecord(invoice))
        .filter(
          (record) => record.externalSubscriptionId === externalSubscriptionId,
        )
        .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime()),
    );
  }

  retrievePaymentMethod(
    externalSubscriptionId: string,
  ): Promise<ProviderPaymentMethodSummary> {
    this.call('retrievePaymentMethod', externalSubscriptionId);
    const sub = this.subscriptions.get(externalSubscriptionId);
    if (!sub) {
      return Promise.reject(new SaasBillingProviderError('resource_missing'));
    }
    const source = sub.hasPaymentMethod
      ? (sub.paymentMethodSource ?? 'SUBSCRIPTION')
      : null;
    const shown =
      this.paymentMethods.get(externalSubscriptionId) ??
      (source === null
        ? { type: null, card: null }
        : {
            type: 'card',
            card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
          });
    return Promise.resolve({
      externalSubscriptionId,
      externalCustomerId: sub.externalCustomerId,
      livemode: false,
      source,
      ...shown,
    });
  }

  // SC3e-1 — an invoice's history record (with its document links).
  private invoiceRecord(
    invoice: ProviderPayableInvoice,
  ): ProviderInvoiceRecord {
    const paid = invoice.status === 'paid';
    return {
      externalInvoiceId: invoice.externalInvoiceId,
      externalCustomerId: invoice.externalCustomerId,
      externalSubscriptionId: invoice.externalSubscriptionId,
      livemode: invoice.livemode,
      number:
        invoice.status === 'draft'
          ? null
          : `FAKE-${invoice.externalInvoiceId.slice(-6).toUpperCase()}`,
      status: invoice.status,
      billingReason: invoice.billingReason ?? null,
      currency: (invoice.currency || 'usd').toLowerCase(),
      totalMinorUnits: invoice.amountDueMinorUnits,
      amountDueMinorUnits: invoice.amountDueMinorUnits,
      amountPaidMinorUnits: invoice.amountPaidMinorUnits,
      amountRemainingMinorUnits:
        invoice.status === 'open' || invoice.status === 'uncollectible'
          ? Math.max(
              0,
              invoice.amountDueMinorUnits - invoice.amountPaidMinorUnits,
            )
          : 0,
      postPaymentCreditMinorUnits: 0,
      prePaymentCreditMinorUnits: 0,
      balanceAppliedMinorUnits: 0,
      periodStart: null,
      periodEnd: null,
      issuedAt: invoice.createdAt,
      paidAt: paid ? invoice.createdAt : null,
      hostedInvoiceUrl: invoice.hostedInvoiceUrl,
      invoicePdfUrl: `https://pay.fake.test/invoice/${invoice.externalInvoiceId}/pdf`,
      ...this.invoiceDetails.get(invoice.externalInvoiceId),
    };
  }

  listOpenInvoices(
    externalSubscriptionId: string,
  ): Promise<ProviderPayableInvoice[]> {
    this.call('listOpenInvoices', externalSubscriptionId);
    return Promise.resolve(
      [...this.invoices.values()]
        .filter(
          (invoice) =>
            invoice.status === 'open' &&
            invoice.externalSubscriptionId === externalSubscriptionId,
        )
        .concat(this.unreadableOpenInvoices.get(externalSubscriptionId) ?? [])
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((invoice) => ({ ...invoice })),
    );
  }

  retrievePortalConfiguration(
    configurationId: string,
  ): Promise<ProviderPortalConfiguration> {
    this.call('retrievePortalConfiguration', configurationId);
    if (configurationId !== this.portalConfiguration.configurationId) {
      return Promise.reject(new SaasBillingProviderError('resource_missing'));
    }
    return Promise.resolve({ ...this.portalConfiguration });
  }

  createPortalSession(input: {
    externalCustomerId: string;
    configurationId: string;
    returnUrl: string;
  }): Promise<{ url: string; livemode: boolean }> {
    this.call('createPortalSession', input.externalCustomerId);
    this.portalSessions.push({
      customer: input.externalCustomerId,
      returnUrl: input.returnUrl,
    });
    return Promise.resolve({
      url: `https://billing.fake.test/p/${hex()}`,
      livemode: false,
    });
  }

  // --- SC3d-1: plan changes ----------------------------------------------------

  // A simple, deterministic proration (days of the period left): the
  // unused time of the current price is credited; a same-interval change
  // charges the new price for the time left, an interval change charges the
  // new price in full (a new period starts).
  private quote(
    externalSubscriptionId: string,
    externalItemId: string,
    toExternalPriceId: string,
    at: Date,
  ): ProviderChargePreview {
    const sub = this.subscriptions.get(externalSubscriptionId);
    const item = sub?.items?.find((i) => i.externalItemId === externalItemId);
    const from = item?.externalPriceId
      ? this.priceCatalog.get(item.externalPriceId)
      : undefined;
    const to = this.priceCatalog.get(toExternalPriceId);
    if (!sub || !item || !from || !to) {
      throw new SaasBillingProviderError('resource_missing');
    }
    if (from.currency !== to.currency) {
      throw new SaasBillingProviderError('currency_mismatch');
    }
    const length = (from.interval === 'YEAR' ? 365 : 30) * 86_400_000;
    const end = sub.currentPeriodEnd?.getTime() ?? at.getTime() + length;
    const left = Math.min(1, Math.max(0, (end - at.getTime()) / length));
    const credit = Math.round(from.amountMinorUnits * left);
    const charge =
      from.interval === to.interval
        ? Math.round(to.amountMinorUnits * left)
        : to.amountMinorUnits;
    const adjust = this.previewAdjust ?? {};
    this.previewAdjust = null;
    const total = charge - credit;
    return {
      livemode: false,
      currency: to.currency,
      amountDueMinorUnits: Math.max(0, total),
      totalMinorUnits: total,
      taxMinorUnits: 0,
      discountMinorUnits: 0,
      prorationMinorUnits: total,
      ...adjust,
    };
  }

  previewImmediateChange(input: {
    externalSubscriptionId: string;
    externalItemId: string;
    toExternalPriceId: string;
    prorationDate: Date;
  }): Promise<ProviderChargePreview> {
    this.call('previewImmediateChange', input.externalSubscriptionId);
    try {
      return Promise.resolve(
        this.quote(
          input.externalSubscriptionId,
          input.externalItemId,
          input.toExternalPriceId,
          input.prorationDate,
        ),
      );
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }

  previewRecurring(input: {
    externalSubscriptionId: string;
    externalItemId: string;
    toExternalPriceId: string;
  }): Promise<ProviderRecurringPreview> {
    this.call('previewRecurring', input.externalSubscriptionId);
    const to = this.priceCatalog.get(input.toExternalPriceId);
    const sub = this.subscriptions.get(input.externalSubscriptionId);
    if (
      !to ||
      !sub?.items?.some((i) => i.externalItemId === input.externalItemId)
    ) {
      return Promise.reject(new SaasBillingProviderError('resource_missing'));
    }
    return Promise.resolve({
      livemode: false,
      currency: to.currency,
      totalMinorUnits: to.amountMinorUnits,
    });
  }

  changePriceNow(input: {
    idempotencyKey: string;
    externalSubscriptionId: string;
    externalItemId: string;
    toExternalPriceId: string;
    prorationDate: Date;
  }): Promise<ProviderPriceChangeResult> {
    this.call('changePriceNow', input.idempotencyKey);
    const replay = this.changeResults.get(input.idempotencyKey);
    if (replay) return Promise.resolve({ ...replay });
    let preview: ProviderChargePreview;
    try {
      preview = this.quote(
        input.externalSubscriptionId,
        input.externalItemId,
        input.toExternalPriceId,
        input.prorationDate,
      );
    } catch (error) {
      return Promise.reject(error as Error);
    }
    const sub = this.subscriptions.get(input.externalSubscriptionId)!;
    if (sub.scheduleId) {
      return Promise.reject(new SaasBillingProviderError('schedule_attached'));
    }
    const invoiceId = `fake_in_change_${hex()}`;
    const paid = !this.failNextChangePayment;
    this.failNextChangePayment = false;
    this.setInvoice(
      invoiceId,
      paid ? 'paid' : 'open',
      input.externalSubscriptionId,
      sub.externalCustomerId,
      {
        amountMinorUnits: preview.amountDueMinorUnits,
        billingReason: 'subscription_update',
        amountPaidMinorUnits: this.paidAdjust ?? undefined,
      },
    );
    this.paidAdjust = null;
    // "Apply only if paid": unpaid, the subscription is unchanged.
    const next: ProviderSubscriptionSnapshot = paid
      ? this.applyChange(
          sub,
          input.externalItemId,
          input.toExternalPriceId,
          input.prorationDate,
          invoiceId,
        )
      : { ...sub, latestInvoiceId: invoiceId, hasPendingUpdate: true };
    if (!paid) {
      this.pendingChanges.set(input.externalSubscriptionId, {
        externalItemId: input.externalItemId,
        toExternalPriceId: input.toExternalPriceId,
        externalInvoiceId: invoiceId,
        at: input.prorationDate,
      });
    }
    this.subscriptions.set(input.externalSubscriptionId, next);
    const result = {
      snapshot: { ...next },
      externalInvoiceId: invoiceId,
      pendingUpdate: !paid,
    };
    this.changeResults.set(input.idempotencyKey, result);
    return Promise.resolve({ ...result });
  }

  schedulePriceChangeAtPeriodEnd(input: {
    idempotencyKey: string;
    externalSubscriptionId: string;
    fromExternalPriceId: string;
    toExternalPriceId: string;
    toInterval: 'MONTH' | 'YEAR';
  }): Promise<{ externalScheduleId: string }> {
    this.call('schedulePriceChangeAtPeriodEnd', input.idempotencyKey);
    const replay = this.schedulesByKey.get(input.idempotencyKey);
    if (replay) return Promise.resolve({ externalScheduleId: replay });
    const sub = this.subscriptions.get(input.externalSubscriptionId);
    if (!sub) {
      return Promise.reject(new SaasBillingProviderError('resource_missing'));
    }
    if (sub.scheduleId) {
      return Promise.reject(new SaasBillingProviderError('schedule_attached'));
    }
    const scheduleId = `fake_sub_sched_${hex()}`;
    this.schedules.set(scheduleId, {
      externalSubscriptionId: input.externalSubscriptionId,
      fromExternalPriceId: input.fromExternalPriceId,
      toExternalPriceId: input.toExternalPriceId,
      status: 'active',
      // Fixed when created (as Stripe's phase dates are): the trial end, or
      // the period end.
      switchAt:
        sub.status === 'trialing' && sub.trialEnd
          ? sub.trialEnd
          : (sub.currentPeriodEnd ?? null),
    });
    this.schedulesByKey.set(input.idempotencyKey, scheduleId);
    this.subscriptions.set(input.externalSubscriptionId, {
      ...sub,
      scheduleId,
    });
    return Promise.resolve({ externalScheduleId: scheduleId });
  }

  retrieveSchedule(
    externalScheduleId: string,
  ): Promise<ProviderSchedule | null> {
    this.call('retrieveSchedule', externalScheduleId);
    const schedule = this.schedules.get(externalScheduleId);
    if (!schedule) return Promise.resolve(null);
    const sub = this.subscriptions.get(schedule.externalSubscriptionId);
    const end = sub?.currentPeriodEnd ?? null;
    return Promise.resolve({
      externalScheduleId,
      livemode: false,
      status: schedule.status,
      externalSubscriptionId: schedule.externalSubscriptionId,
      phases: [
        {
          externalPriceId: schedule.fromExternalPriceId,
          quantity: 1,
          startDate: sub?.currentPeriodStart ?? null,
          endDate: schedule.switchAt ?? end,
          trialEnd: sub?.trialEnd ?? null,
        },
        {
          externalPriceId: schedule.toExternalPriceId,
          quantity: 1,
          startDate: schedule.switchAt ?? end,
          endDate: null,
          trialEnd: null,
        },
      ],
    });
  }

  // SC3d-3 — the schedule's next phase starts: the subscription moves to the
  // new price and a new period (the trial, if any, ends). The schedule stays
  // attached for its last phase.
  switchSchedule(externalScheduleId: string, switchAt?: Date): void {
    const schedule = this.schedules.get(externalScheduleId)!;
    const at = switchAt ?? schedule.switchAt ?? new Date();
    const sub = this.subscriptions.get(schedule.externalSubscriptionId)!;
    const to = this.priceCatalog.get(schedule.toExternalPriceId);
    const length = (to?.interval === 'YEAR' ? 365 : 30) * 86_400_000;
    this.subscriptions.set(schedule.externalSubscriptionId, {
      ...sub,
      status: sub.status === 'trialing' ? 'active' : sub.status,
      items: sub.items!.map((item, index) =>
        index === 0
          ? { ...item, externalPriceId: schedule.toExternalPriceId }
          : item,
      ),
      currentPeriodStart: at,
      currentPeriodEnd: new Date(at.getTime() + length),
    });
  }

  // SC3d-3 — tests: a schedule changed outside CENTERIVO (cancelled,
  // released, completed or re-priced in the provider dashboard). Detaching
  // removes it from its subscription.
  alterSchedule(
    externalScheduleId: string,
    patch: {
      status?: 'active' | 'released' | 'canceled' | 'completed';
      toExternalPriceId?: string;
      switchAt?: Date;
      detach?: boolean;
      remove?: boolean;
    },
  ): void {
    const schedule = this.schedules.get(externalScheduleId)!;
    const { detach, remove, ...rest } = patch;
    Object.assign(schedule, rest);
    if (detach || remove) {
      const sub = this.subscriptions.get(schedule.externalSubscriptionId);
      if (sub && sub.scheduleId === externalScheduleId) {
        this.subscriptions.set(schedule.externalSubscriptionId, {
          ...sub,
          scheduleId: null,
        });
      }
    }
    if (remove) this.schedules.delete(externalScheduleId);
  }

  // Releases the schedule: the subscription itself is left exactly as it is.
  // --- SC3e-3: credit notes and refunds (a Stripe-like model) -----------------
  // Tax: `taxBasisPoints` per invoice (default 0), applied to the credited
  // pre-tax amounts, as Stripe applies the invoice's tax. A paid invoice is
  // paid by one payment intent (`pi_<invoice>`).
  readonly taxBasisPoints = new Map<string, number>();
  readonly creditNotes = new Map<
    string,
    ProviderCreditNote & { key: string | null }
  >();
  readonly refunds = new Map<string, ProviderRefund & { invoiceId: string }>();
  // Tests: the status a new refund gets (default succeeded).
  nextRefundStatus = 'succeeded';
  // Tests: the credit note is created, then the call fails (a timeout after
  // the provider applied it).
  failAfterCreditNote = false;

  private paymentIntentOf(invoiceId: string): string {
    return `pi_${invoiceId}`;
  }

  private adjustable(invoiceId: string): ProviderAdjustableInvoice | null {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) return null;
    const record = this.invoiceRecord(invoice);
    const credited = [...this.creditNotes.values()]
      .filter(
        (note) =>
          note.externalInvoiceId === invoiceId && note.status === 'issued',
      )
      .reduce((total, note) => total + note.totalMinorUnits, 0);
    const refunded = [...this.refunds.values()]
      .filter(
        (refund) =>
          refund.invoiceId === invoiceId &&
          refund.status !== 'failed' &&
          refund.status !== 'canceled',
      )
      .reduce((total, refund) => total + refund.amountMinorUnits, 0);
    const paid = invoice.status === 'paid' && invoice.amountPaidMinorUnits > 0;
    return {
      externalInvoiceId: invoiceId,
      externalCustomerId: record.externalCustomerId,
      externalSubscriptionId: record.externalSubscriptionId,
      livemode: false,
      status: record.status,
      currency: record.currency,
      amountPaidMinorUnits: record.amountPaidMinorUnits,
      postPaymentCreditMinorUnits: credited,
      lines: [
        {
          externalLineId: `il_${invoiceId}`,
          description: 'Subscription',
          amountMinorUnits: record.totalMinorUnits,
          periodStart: record.periodStart,
          periodEnd: record.periodEnd,
        },
      ],
      paymentIntentIds: paid ? [this.paymentIntentOf(invoiceId)] : [],
      chargeCapturedMinorUnits: paid ? invoice.amountPaidMinorUnits : 0,
      chargeRefundedMinorUnits: refunded,
    };
  }

  private priced(input: ProviderCreditNoteInput): {
    currency: string;
    totalMinorUnits: number;
    taxMinorUnits: number;
  } {
    const invoice = this.adjustable(input.externalInvoiceId);
    if (!invoice || invoice.status !== 'paid') {
      throw new SaasBillingProviderError('invoice_not_paid');
    }
    let pretax = 0;
    for (const line of input.lines) {
      const own = invoice.lines.find(
        (l) => l.externalLineId === line.externalLineId,
      );
      if (
        !own ||
        line.amountMinorUnits <= 0 ||
        line.amountMinorUnits > own.amountMinorUnits
      ) {
        throw new SaasBillingProviderError('credit_note_invalid_line');
      }
      pretax += line.amountMinorUnits;
    }
    const tax = Math.round(
      (pretax * (this.taxBasisPoints.get(input.externalInvoiceId) ?? 0)) /
        10_000,
    );
    const total = pretax + tax;
    const externalRefunds = Math.max(
      0,
      invoice.chargeRefundedMinorUnits -
        [...this.creditNotes.values()]
          .filter((n) => n.externalInvoiceId === input.externalInvoiceId)
          .reduce(
            (t, n) => t + n.refunds.reduce((u, r) => u + r.amountMinorUnits, 0),
            0,
          ),
    );
    if (
      total >
      invoice.amountPaidMinorUnits -
        invoice.postPaymentCreditMinorUnits -
        externalRefunds
    ) {
      throw new SaasBillingProviderError('credit_note_exceeds_invoice');
    }
    return {
      currency: invoice.currency,
      totalMinorUnits: total,
      taxMinorUnits: tax,
    };
  }

  retrieveAdjustableInvoice(
    externalInvoiceId: string,
  ): Promise<ProviderAdjustableInvoice | null> {
    this.call('retrieveAdjustableInvoice', externalInvoiceId);
    return Promise.resolve(this.adjustable(externalInvoiceId));
  }

  previewCreditNote(input: ProviderCreditNoteInput): Promise<{
    currency: string;
    totalMinorUnits: number;
    taxMinorUnits: number;
  }> {
    this.call('previewCreditNote', input.externalInvoiceId);
    try {
      return Promise.resolve(this.priced(input));
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }

  // Credit notes are issued once per idempotency key (a replay returns the
  // same one).
  createCreditNote(input: {
    idempotencyKey: string;
    adjustmentId: string;
    note: ProviderCreditNoteInput;
    totalMinorUnits: number;
  }): Promise<ProviderCreditNote> {
    this.call('createCreditNote', input.idempotencyKey);
    const replay = [...this.creditNotes.values()].find(
      (note) => note.key === input.idempotencyKey,
    );
    if (replay) return Promise.resolve(view(replay));
    let priced: {
      currency: string;
      totalMinorUnits: number;
      taxMinorUnits: number;
    };
    try {
      priced = this.priced(input.note);
    } catch (error) {
      return Promise.reject(error as Error);
    }
    if (priced.totalMinorUnits !== input.totalMinorUnits) {
      return Promise.reject(
        new SaasBillingProviderError('credit_note_amount_mismatch'),
      );
    }
    const noteId = `cn_${hex()}`;
    const refunds: { externalRefundId: string; amountMinorUnits: number }[] =
      [];
    if (input.note.kind === 'REFUND') {
      const refundId = `re_${hex()}`;
      this.refunds.set(refundId, {
        externalRefundId: refundId,
        livemode: false,
        status: this.nextRefundStatus,
        amountMinorUnits: priced.totalMinorUnits,
        currency: priced.currency,
        paymentIntentId: this.paymentIntentOf(input.note.externalInvoiceId),
        invoiceId: input.note.externalInvoiceId,
      });
      refunds.push({
        externalRefundId: refundId,
        amountMinorUnits: priced.totalMinorUnits,
      });
    }
    const note = {
      externalCreditNoteId: noteId,
      externalInvoiceId: input.note.externalInvoiceId,
      livemode: false,
      status: 'issued',
      currency: priced.currency,
      totalMinorUnits: priced.totalMinorUnits,
      taxMinorUnits: priced.taxMinorUnits,
      outOfBandMinorUnits: 0,
      refunds,
      centerivoAdjustmentId: input.adjustmentId,
      key: input.idempotencyKey,
    };
    this.creditNotes.set(noteId, note);
    this.syncCredited(input.note.externalInvoiceId);
    if (this.failAfterCreditNote) {
      this.failAfterCreditNote = false;
      return Promise.reject(
        new SaasBillingProviderError('api_connection_error'),
      );
    }
    return Promise.resolve(view(note));
  }

  listCreditNotes(externalInvoiceId: string): Promise<ProviderCreditNote[]> {
    this.call('listCreditNotes', externalInvoiceId);
    return Promise.resolve(
      [...this.creditNotes.values()]
        .filter((note) => note.externalInvoiceId === externalInvoiceId)
        .map(view),
    );
  }

  listInvoiceRefunds(externalInvoiceId: string): Promise<ProviderRefund[]> {
    this.call('listInvoiceRefunds', externalInvoiceId);
    return Promise.resolve(
      [...this.refunds.values()]
        .filter((refund) => refund.invoiceId === externalInvoiceId)
        .map(({ invoiceId: _invoice, ...refund }) => {
          void _invoice;
          return refund;
        }),
    );
  }

  findInvoiceForPayment(paymentIntentId: string): Promise<string | null> {
    this.call('findInvoiceForPayment', paymentIntentId);
    return Promise.resolve(
      paymentIntentId.startsWith('pi_') ? paymentIntentId.slice(3) : null,
    );
  }

  // Tests: the invoice history's credited amount follows the credit notes.
  private syncCredited(invoiceId: string): void {
    const credited = [...this.creditNotes.values()]
      .filter(
        (note) =>
          note.externalInvoiceId === invoiceId && note.status === 'issued',
      )
      .reduce((total, note) => total + note.totalMinorUnits, 0);
    this.invoiceDetails.set(invoiceId, {
      ...this.invoiceDetails.get(invoiceId),
      postPaymentCreditMinorUnits: credited,
    });
  }

  // Tests: actions taken directly in Stripe (outside CENTERIVO).
  externalCreditNote(
    invoiceId: string,
    kind: 'REFUND' | 'CREDIT',
    totalMinorUnits: number,
  ): string {
    const noteId = `cn_ext_${hex()}`;
    const refunds: { externalRefundId: string; amountMinorUnits: number }[] =
      [];
    if (kind === 'REFUND') {
      const refundId = `re_ext_${hex()}`;
      this.refunds.set(refundId, {
        externalRefundId: refundId,
        livemode: false,
        status: 'succeeded',
        amountMinorUnits: totalMinorUnits,
        currency: 'usd',
        paymentIntentId: this.paymentIntentOf(invoiceId),
        invoiceId,
      });
      refunds.push({
        externalRefundId: refundId,
        amountMinorUnits: totalMinorUnits,
      });
    }
    this.creditNotes.set(noteId, {
      externalCreditNoteId: noteId,
      externalInvoiceId: invoiceId,
      livemode: false,
      status: 'issued',
      currency: 'usd',
      totalMinorUnits,
      taxMinorUnits: 0,
      outOfBandMinorUnits: 0,
      refunds,
      centerivoAdjustmentId: null,
      key: null,
    });
    this.syncCredited(invoiceId);
    return noteId;
  }

  externalRefund(invoiceId: string, amountMinorUnits: number): string {
    const refundId = `re_ext_${hex()}`;
    this.refunds.set(refundId, {
      externalRefundId: refundId,
      livemode: false,
      status: 'succeeded',
      amountMinorUnits,
      currency: 'usd',
      paymentIntentId: this.paymentIntentOf(invoiceId),
      invoiceId,
    });
    return refundId;
  }

  // SC3e-2 — cancel at period end (or undo it). The subscription keeps
  // running until a test ends it (endSubscription).
  setCancelAtPeriodEnd(input: {
    idempotencyKey: string;
    externalSubscriptionId: string;
    cancelAtPeriodEnd: boolean;
  }): Promise<void> {
    this.call('setCancelAtPeriodEnd', input.idempotencyKey);
    const sub = this.subscriptions.get(input.externalSubscriptionId);
    if (!sub) {
      return Promise.reject(new SaasBillingProviderError('resource_missing'));
    }
    if (sub.status === 'canceled' || sub.status === 'incomplete_expired') {
      return Promise.reject(new SaasBillingProviderError('subscription_ended'));
    }
    if (sub.scheduleId) {
      return Promise.reject(new SaasBillingProviderError('schedule_attached'));
    }
    if (!this.ignoreCancelRequests) {
      this.subscriptions.set(input.externalSubscriptionId, {
        ...sub,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
      });
    }
    return Promise.resolve();
  }

  // SC3e-2 — tests: a provider that accepts the request but does not apply
  // it (verification must catch that).
  ignoreCancelRequests = false;

  // SC3e-2 — tests: the period ends and the provider ends the subscription
  // (after a scheduled cancellation).
  endSubscription(externalSubscriptionId: string): void {
    const sub = this.subscriptions.get(externalSubscriptionId)!;
    this.subscriptions.set(externalSubscriptionId, {
      ...sub,
      status: 'canceled',
      cancelAtPeriodEnd: false,
      scheduleId: null,
    });
  }

  listUnpaidCustomerInvoices(
    externalCustomerId: string,
  ): Promise<ProviderPayableInvoice[]> {
    this.call('listUnpaidCustomerInvoices', externalCustomerId);
    return Promise.resolve(
      [...this.invoices.values()]
        .filter(
          (invoice) =>
            invoice.externalCustomerId === externalCustomerId &&
            (invoice.status === 'open' || invoice.status === 'uncollectible'),
        )
        .map((invoice) => ({ ...invoice })),
    );
  }

  releaseSchedule(input: {
    idempotencyKey: string;
    externalScheduleId: string;
  }): Promise<{ releasedSubscriptionId: string | null }> {
    this.call('releaseSchedule', input.idempotencyKey);
    const schedule = this.schedules.get(input.externalScheduleId);
    if (!schedule) {
      return Promise.reject(new SaasBillingProviderError('resource_missing'));
    }
    if (schedule.status === 'active') {
      schedule.status = 'released';
      const sub = this.subscriptions.get(schedule.externalSubscriptionId);
      if (sub && sub.scheduleId === input.externalScheduleId) {
        this.subscriptions.set(schedule.externalSubscriptionId, {
          ...sub,
          scheduleId: null,
        });
      }
    }
    return Promise.resolve({
      releasedSubscriptionId: schedule.externalSubscriptionId,
    });
  }

  // The item moves to the new price; an interval change starts a new period.
  private applyChange(
    sub: ProviderSubscriptionSnapshot,
    externalItemId: string,
    toExternalPriceId: string,
    at: Date,
    invoiceId: string,
  ): ProviderSubscriptionSnapshot {
    const fromPrice = sub.items?.find(
      (i) => i.externalItemId === externalItemId,
    )?.externalPriceId;
    const from = fromPrice ? this.priceCatalog.get(fromPrice) : undefined;
    const to = this.priceCatalog.get(toExternalPriceId);
    const newPeriod = from && to && from.interval !== to.interval;
    return {
      ...sub,
      items: sub.items!.map((i) =>
        i.externalItemId === externalItemId
          ? { ...i, externalPriceId: toExternalPriceId }
          : i,
      ),
      latestInvoiceId: invoiceId,
      hasPendingUpdate: false,
      ...(newPeriod
        ? {
            currentPeriodStart: at,
            currentPeriodEnd: new Date(
              at.getTime() + (to.interval === 'YEAR' ? 365 : 30) * 86_400_000,
            ),
          }
        : {}),
    };
  }

  // SC3d-2 — the owner pays the waiting invoice (e.g. after 3-D Secure or
  // with another card): Stripe applies the pending update.
  payPendingChange(externalSubscriptionId: string): void {
    const pending = this.pendingChanges.get(externalSubscriptionId)!;
    const sub = this.subscriptions.get(externalSubscriptionId)!;
    const invoice = this.invoices.get(pending.externalInvoiceId)!;
    this.invoices.set(pending.externalInvoiceId, {
      ...invoice,
      status: 'paid',
      amountPaidMinorUnits: invoice.amountDueMinorUnits,
    });
    this.subscriptions.set(
      externalSubscriptionId,
      this.applyChange(
        sub,
        pending.externalItemId,
        pending.toExternalPriceId,
        pending.at,
        pending.externalInvoiceId,
      ),
    );
    this.pendingChanges.delete(externalSubscriptionId);
  }

  // SC3d-2 — the pending update expires: Stripe voids its invoice and
  // discards the change.
  expirePendingChange(externalSubscriptionId: string): void {
    const pending = this.pendingChanges.get(externalSubscriptionId)!;
    const invoice = this.invoices.get(pending.externalInvoiceId)!;
    this.invoices.set(pending.externalInvoiceId, {
      ...invoice,
      status: 'void',
    });
    this.setSubscription(externalSubscriptionId, { hasPendingUpdate: false });
    this.pendingChanges.delete(externalSubscriptionId);
  }

  // --- test helpers (the provider side) --------------------------------------

  // The owner finished Checkout: the provider created a subscription.
  completeCheckout(
    externalSessionId: string,
    opts: {
      hasPaymentMethod: boolean;
      now?: Date;
      // SC3c-2 — a subscription without a trial has a first invoice: paid
      // (the default, as Checkout collects it) or still open.
      firstInvoice?: 'paid' | 'open';
    },
  ): ProviderSubscriptionSnapshot {
    const checkout = this.checkouts.get(externalSessionId)!;
    const now = opts.now ?? new Date();
    const subscriptionId = `fake_sub_${hex()}`;
    const trial = checkout.trialDays > 0;
    const firstInvoiceId = trial ? null : `fake_in_first_${hex()}`;
    const snapshot: ProviderSubscriptionSnapshot = {
      externalSubscriptionId: subscriptionId,
      externalCustomerId: checkout.externalCustomerId!,
      status: trial ? 'trialing' : 'active',
      livemode: false,
      hasPaymentMethod: opts.hasPaymentMethod,
      paymentMethodSource: opts.hasPaymentMethod ? 'SUBSCRIPTION' : null,
      cancelAtPeriodEnd: false,
      trialStart: trial ? now : null,
      trialEnd: trial
        ? new Date(now.getTime() + checkout.trialDays * 86_400_000)
        : null,
      latestInvoiceId: firstInvoiceId,
      items: [
        {
          externalItemId: `fake_si_${hex()}`,
          externalPriceId: checkout.externalPriceId,
          quantity: 1,
        },
      ],
      scheduleId: null,
      hasPendingUpdate: false,
      currentPeriodEnd: trial
        ? new Date(now.getTime() + checkout.trialDays * 86_400_000)
        : new Date(now.getTime() + 30 * 86_400_000),
    };
    this.subscriptions.set(subscriptionId, snapshot);
    if (firstInvoiceId !== null) {
      this.setInvoice(
        firstInvoiceId,
        opts.firstInvoice ?? 'paid',
        subscriptionId,
        checkout.externalCustomerId,
      );
    }
    checkout.status = 'complete';
    checkout.externalSubscriptionId = subscriptionId;
    return snapshot;
  }

  setSubscription(
    externalSubscriptionId: string,
    change: Partial<ProviderSubscriptionSnapshot>,
  ): void {
    const current = this.subscriptions.get(externalSubscriptionId)!;
    const next = { ...current, ...change };
    // The two payment-method fields stay consistent, as the real adapter's.
    if (change.paymentMethodSource !== undefined) {
      next.hasPaymentMethod = change.paymentMethodSource !== null;
    } else if (change.hasPaymentMethod !== undefined) {
      next.paymentMethodSource = change.hasPaymentMethod
        ? 'SUBSCRIPTION'
        : null;
    }
    this.subscriptions.set(externalSubscriptionId, next);
  }

  setInvoice(
    externalInvoiceId: string,
    status: ProviderInvoiceStatus,
    externalSubscriptionId: string | null,
    externalCustomerId: string | null,
    opts: {
      amountMinorUnits?: number;
      createdAt?: Date;
      billingReason?: string | null;
      amountPaidMinorUnits?: number;
    } = {},
  ): void {
    const amount = opts.amountMinorUnits ?? 4900;
    const existing = this.invoices.get(externalInvoiceId);
    this.invoices.set(externalInvoiceId, {
      externalInvoiceId,
      status,
      externalSubscriptionId,
      externalCustomerId,
      livemode: false,
      billingReason:
        opts.billingReason !== undefined
          ? opts.billingReason
          : (existing?.billingReason ?? 'subscription_cycle'),
      amountPaidMinorUnits:
        status === 'paid' ? (opts.amountPaidMinorUnits ?? amount) : 0,
      amountDueMinorUnits: amount,
      currency: 'usd',
      createdAt: opts.createdAt ?? existing?.createdAt ?? new Date(),
      hostedInvoiceUrl: `https://invoice.fake.test/i/${externalInvoiceId}`,
    });
  }

  expireCheckout(externalSessionId: string): void {
    const checkout = this.checkouts.get(externalSessionId)!;
    checkout.status = 'expired';
  }

  // The signed delivery a real provider would send.
  signEvent(
    body: FakeEventBody,
    at: Date = new Date(),
  ): { rawBody: string; signatureHeader: string } {
    const rawBody = JSON.stringify(body);
    const timestamp = Math.floor(at.getTime() / 1000);
    return {
      rawBody,
      signatureHeader: `t=${timestamp},v1=${sign(this.webhookSecret, timestamp, rawBody)}`,
    };
  }

  verifyEvent(input: {
    rawBody: string | Buffer;
    signatureHeader: string | undefined;
    now?: Date;
  }): VerifiedBillingProviderEvent {
    const rawBody =
      typeof input.rawBody === 'string'
        ? input.rawBody
        : input.rawBody.toString('utf8');
    if (rawBody.length === 0 || rawBody.length > 65_536) {
      throw new BillingEventVerificationError('Unreadable event.');
    }
    const header = parseHeader(input.signatureHeader);
    if (!header) throw new BillingEventVerificationError('Missing signature.');
    const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
    if (
      Math.abs(nowSeconds - header.timestamp) > FAKE_SIGNATURE_TOLERANCE_SECONDS
    ) {
      throw new BillingEventVerificationError(
        'Signature timestamp out of tolerance.',
      );
    }
    const expected = Buffer.from(
      sign(this.webhookSecret, header.timestamp, rawBody),
      'hex',
    );
    const valid = header.signatures.some((candidate) => {
      const given = Buffer.from(candidate, 'hex');
      return (
        given.length === expected.length && timingSafeEqual(given, expected)
      );
    });
    if (!valid) throw new BillingEventVerificationError('Invalid signature.');

    let body: FakeEventBody;
    try {
      body = JSON.parse(rawBody) as FakeEventBody;
    } catch {
      throw new BillingEventVerificationError('Unreadable event.');
    }
    const eventId = optionalText(body?.id);
    const type = optionalText(body?.type, 100);
    const occurredAt = toDate(body?.created);
    if (
      !eventId ||
      !type ||
      !occurredAt ||
      typeof body.livemode !== 'boolean'
    ) {
      throw new BillingEventVerificationError('Incomplete event.');
    }
    // An event cannot have happened after it was signed.
    if (
      occurredAt.getTime() >
      (header.timestamp + FAKE_SIGNATURE_TOLERANCE_SECONDS) * 1000
    ) {
      throw new BillingEventVerificationError('Event time is in the future.');
    }
    const data =
      typeof body.data === 'object' && body.data !== null ? body.data : {};
    return {
      provider: this.name,
      externalEventId: eventId,
      providerType: type,
      livemode: body.livemode,
      occurredAt,
      payloadDigest: createHash('sha256').update(rawBody).digest('hex'),
      externalSubscriptionId: optionalText(data.subscription),
      externalCustomerId: optionalText(data.customer),
      claimedTenantId: optionalText(data.tenantId),
      event: this.normalize(type, data),
    };
  }

  private normalize(
    type: string,
    data: FakeEventBody['data'],
  ): ProviderLifecycleEvent {
    const reference = optionalText(data.reference);
    switch (type as FakeEventType) {
      case 'payment_method.authorized':
        return { kind: 'PAYMENT_AUTHORIZED' };
      case 'invoice.paid': {
        const amount = data.amount;
        const currency = optionalText(data.currency, 3);
        return reference &&
          currency &&
          typeof amount === 'number' &&
          Number.isInteger(amount) &&
          amount >= 0
          ? {
              kind: 'PAYMENT_SUCCEEDED',
              reference,
              amountMinorUnits: amount,
              currency: currency.toUpperCase(),
              periodStart: toDate(data.periodStart),
              periodEnd: toDate(data.periodEnd),
            }
          : { kind: 'UNSUPPORTED' };
      }
      case 'invoice.payment_failed':
        return reference
          ? { kind: 'PAYMENT_FAILED', reference }
          : { kind: 'UNSUPPORTED' };
      case 'subscription.trial_ended':
        return { kind: 'TRIAL_ENDED' };
      case 'subscription.cancel_scheduled':
        return { kind: 'CANCEL_SCHEDULED' };
      case 'subscription.cancel_undone':
        return { kind: 'CANCEL_UNDONE' };
      case 'subscription.ended':
        return { kind: 'SUBSCRIPTION_ENDED' };
      case 'checkout.completed': {
        const session = optionalText(data.session);
        return session
          ? { kind: 'CHECKOUT_COMPLETED', externalSessionId: session }
          : { kind: 'UNSUPPORTED' };
      }
      case 'subscription.changed':
        return { kind: 'SUBSCRIPTION_CHANGED' };
      case 'invoice.changed':
        return reference
          ? { kind: 'INVOICE_CHANGED', reference }
          : { kind: 'UNSUPPORTED' };
      case 'refund.changed':
        return reference
          ? { kind: 'REFUND_CHANGED', paymentIntentId: reference }
          : { kind: 'UNSUPPORTED' };
      default:
        return { kind: 'UNSUPPORTED' };
    }
  }
}

// SC3e-3 — a credit note as the provider returns it (no idempotency key).
function view(
  note: ProviderCreditNote & { key: string | null },
): ProviderCreditNote {
  const { key: _key, ...rest } = note;
  void _key;
  return { ...rest, refunds: rest.refunds.map((refund) => ({ ...refund })) };
}
