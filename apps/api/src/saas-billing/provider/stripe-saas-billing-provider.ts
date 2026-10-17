import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import type {
  PaymentMethodSource,
  ProviderSubscriptionSnapshot,
  ProviderSubscriptionStatus,
} from '../domain/provider-sync';
import {
  BillingEventVerificationError,
  SaasBillingProviderError,
  type ProviderChargePreview,
  type ProviderCheckoutSession,
  type ProviderPriceChangeResult,
  type ProviderRecurringPreview,
  type ProviderSchedule,
  type ProviderInvoice,
  type ProviderInvoiceStatus,
  type ProviderPayableInvoice,
  type ProviderLifecycleEvent,
  type SaasBillingProvider,
  type VerifiedBillingProviderEvent,
} from './saas-billing-provider';
import type { ProviderPortalConfiguration } from './portal-configuration';

// SC3b — CENTERIVO SaaS billing through Stripe Billing, TEST MODE ONLY (F4):
// the configuration refuses live keys (saas-billing-provider-mode.ts), and
// every object read back or event received must be test-mode (livemode
// false) or it is refused.
//
// Pinned (F1): the SDK version (package.json, exact) and the API version
// below — the SDK's own version, so request and response shapes are the
// ones its types describe.
//
// Deterministic objects (no duplicates under retries or concurrency):
//   * a plan's product has OUR id: centerivo_plan_<planId>; a second create
//     is "already exists" and the existing product is read and checked;
//   * a price has the lookup key centerivo_price_<priceId> and a
//     deterministic idempotency key; an existing price is found by its
//     lookup key and must match our amount, currency, interval and product;
//   * customers and Checkout sessions use the caller's deterministic
//     idempotency keys.
export const STRIPE_API_VERSION = '2026-08-26.dahlia' as const;

const PROVIDER = 'stripe';
// Stripe's documented default signature tolerance.
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

// SC3c-2 — Checkout offers ONLY payment methods that confirm synchronously.
// Asynchronous ones (bank debits, transfers, vouchers…) confirm days later
// and need their own confirmation and recovery lifecycle — not offered
// until that is built and tested (a regression test pins this list).
export const SUPPORTED_CHECKOUT_PAYMENT_METHOD_TYPES = ['card'] as const;

export interface StripeBillingConfig {
  webhookSecret: string;
  // SC3c-2 — the operator-configured Customer Portal configuration and the
  // Stripe account it must belong to (both required for the portal).
  portalConfigurationId?: string | null;
  expectedAccountId?: string | null;
}

function productId(planId: string): string {
  return `centerivo_plan_${planId}`;
}

function priceLookupKey(priceId: string): string {
  return `centerivo_price_${priceId}`;
}

// Where the payment method Stripe will charge automatically comes from.
// Checkout (subscription mode) records the method it collected as the
// subscription's default_payment_method; when a subscription has none,
// Stripe charges the customer's default (invoice_settings
// .default_payment_method, or a legacy default source). A send_invoice
// subscription is never charged automatically.
function paymentMethodSource(sub: Stripe.Subscription): PaymentMethodSource {
  if (sub.collection_method === 'send_invoice') return null;
  if (
    id(sub.default_payment_method) !== null ||
    id(sub.default_source) !== null
  ) {
    return 'SUBSCRIPTION';
  }
  const customer = sub.customer;
  if (
    typeof customer === 'object' &&
    customer !== null &&
    !('deleted' in customer && customer.deleted === true)
  ) {
    const live = customer;
    if (
      id(live.invoice_settings?.default_payment_method) !== null ||
      id(live.default_source) !== null
    ) {
      return 'CUSTOMER_DEFAULT';
    }
  }
  return null;
}

function id(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  ) {
    return (value as { id: string }).id;
  }
  return null;
}

function date(seconds: unknown): Date | null {
  return typeof seconds === 'number' && Number.isInteger(seconds) && seconds > 0
    ? new Date(seconds * 1000)
    : null;
}

const OPEN_INVOICE_CAP = 500;

// SC3d-1 — an integer amount that may be negative (an invoice total after
// credits); anything else is refused rather than guessed.
function signedAmount(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw new SaasBillingProviderError('preview_amount_unreadable');
}

function sum(values: unknown[]): number {
  return values.reduce<number>(
    (total, value) => total + signedAmount(value),
    0,
  );
}

const seconds = (at: Date) => Math.floor(at.getTime() / 1000);

// SC3d-3 — what the next phase keeps from the current one (Stripe unsets
// what a phase omits): everything but the item, the dates, the trial end and
// the currency (the new price's own).
function carriedSettings(
  phase: Stripe.SubscriptionScheduleUpdateParams.Phase,
): Omit<Stripe.SubscriptionScheduleUpdateParams.Phase, 'items'> {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const {
    items,
    start_date,
    end_date,
    trial_end,
    currency,
    proration_behavior,
    ...carried
  } = phase;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return carried;
}

// SC3d-3 — the schedule's current phase as update parameters, exactly as it
// is (our one item at our price, its dates and trial end, payment, tax,
// invoice settings, discounts and metadata). null when it carries anything we
// do not reproduce faithfully (the caller then changes nothing).
function currentPhaseParams(
  phase: Stripe.SubscriptionSchedule.Phase,
  expectedPrice: string,
): Stripe.SubscriptionScheduleUpdateParams.Phase | null {
  const item = phase.items?.length === 1 ? phase.items[0] : null;
  if (
    item === null ||
    id(item.price) !== expectedPrice ||
    (item.quantity ?? 1) !== 1 ||
    (item.discounts ?? []).length > 0 ||
    (phase.add_invoice_items ?? []).length > 0 ||
    phase.application_fee_percent != null ||
    phase.billing_thresholds != null ||
    phase.on_behalf_of != null ||
    phase.transfer_data != null ||
    (phase.automatic_tax?.enabled === true &&
      phase.automatic_tax.liability != null &&
      phase.automatic_tax.liability.type !== 'self')
  ) {
    return null;
  }
  const discounts: Stripe.SubscriptionScheduleUpdateParams.Phase.Discount[] =
    [];
  for (const discount of phase.discounts ?? []) {
    const existing = id(discount.discount);
    const coupon = id(discount.coupon);
    const promotion = id(discount.promotion_code);
    if (existing) discounts.push({ discount: existing });
    else if (coupon) discounts.push({ coupon });
    else if (promotion) discounts.push({ promotion_code: promotion });
    else return null;
  }
  const params: Stripe.SubscriptionScheduleUpdateParams.Phase = {
    items: [
      {
        price: expectedPrice,
        quantity: 1,
        ...(item.tax_rates && item.tax_rates.length > 0
          ? { tax_rates: item.tax_rates.map((rate) => rate.id) }
          : {}),
        ...(item.metadata && Object.keys(item.metadata).length > 0
          ? { metadata: item.metadata }
          : {}),
      },
    ],
    start_date: phase.start_date,
    end_date: phase.end_date,
    proration_behavior: 'none',
    currency: phase.currency,
  };
  if (typeof phase.trial_end === 'number') params.trial_end = phase.trial_end;
  if (phase.collection_method != null) {
    params.collection_method = phase.collection_method;
  }
  const paymentMethod = id(phase.default_payment_method ?? null);
  if (paymentMethod !== null) params.default_payment_method = paymentMethod;
  if (phase.default_tax_rates && phase.default_tax_rates.length > 0) {
    params.default_tax_rates = phase.default_tax_rates.map((rate) => rate.id);
  }
  if (phase.description != null) params.description = phase.description;
  if (discounts.length > 0) params.discounts = discounts;
  if (phase.metadata && Object.keys(phase.metadata).length > 0) {
    params.metadata = phase.metadata;
  }
  if (phase.automatic_tax?.enabled === true) {
    params.automatic_tax = { enabled: true };
  }
  if (phase.invoice_settings?.days_until_due != null) {
    params.invoice_settings = {
      days_until_due: phase.invoice_settings.days_until_due,
    };
  }
  return params;
}

function amount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function text(value: unknown, max = 255): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : null;
}

// A provider failure becomes a short, retryable code — never provider text.
function providerError(error: unknown): SaasBillingProviderError {
  if (error instanceof SaasBillingProviderError) return error;
  const e = error as { type?: unknown; code?: unknown };
  const code =
    (typeof e?.code === 'string' && e.code) ||
    (typeof e?.type === 'string' && e.type) ||
    'unknown';
  return new SaasBillingProviderError(code.slice(0, 60));
}

const SUBSCRIPTION_STATUSES: readonly ProviderSubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'paused',
];

// The portal features we read explicitly; any other enabled one refuses
// the configuration (portal-configuration.ts).
const KNOWN_PORTAL_FEATURES = new Set([
  'customer_update',
  'invoice_history',
  'payment_method_update',
  'subscription_cancel',
  'subscription_update',
]);

const INVOICE_STATUSES: readonly ProviderInvoiceStatus[] = [
  'draft',
  'open',
  'paid',
  'uncollectible',
  'void',
];

export class StripeSaasBillingProvider implements SaasBillingProvider {
  readonly name = PROVIDER;
  readonly livemode = false;
  readonly available = true;

  constructor(
    private readonly stripe: Stripe,
    private readonly config: StripeBillingConfig,
  ) {}

  static create(secretKey: string, config: StripeBillingConfig) {
    return new StripeSaasBillingProvider(
      new Stripe(secretKey, {
        apiVersion: STRIPE_API_VERSION,
        maxNetworkRetries: 2,
        timeout: 20_000,
        telemetry: false,
        appInfo: { name: 'CENTERIVO SaaS billing' },
      }),
      config,
    );
  }

  private assertTestMode(livemode: unknown): void {
    if (livemode !== false) {
      throw new SaasBillingProviderError('live_mode_refused');
    }
  }

  async ensureProduct(input: {
    planId: string;
    planName: string;
  }): Promise<{ externalProductId: string }> {
    const productIdValue = productId(input.planId);
    try {
      const product = await this.stripe.products.create(
        {
          id: productIdValue,
          name: input.planName.slice(0, 250),
          metadata: { centerivo_plan_id: input.planId },
        },
        { idempotencyKey: `centerivo-product-${input.planId}` },
      );
      this.assertTestMode(product.livemode);
      return { externalProductId: product.id };
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code !== 'resource_already_exists') throw providerError(error);
    }
    // Created earlier (another request or a retry): read and check it.
    try {
      const existing = await this.stripe.products.retrieve(productIdValue);
      this.assertTestMode(existing.livemode);
      if (existing.metadata?.centerivo_plan_id !== input.planId) {
        throw new SaasBillingProviderError('product_mismatch');
      }
      return { externalProductId: existing.id };
    } catch (error) {
      throw providerError(error);
    }
  }

  async ensurePrice(input: {
    priceId: string;
    externalProductId: string;
    amountMinorUnits: number;
    currency: string;
    interval: 'MONTH' | 'YEAR';
  }): Promise<{ externalPriceId: string }> {
    const lookupKey = priceLookupKey(input.priceId);
    const interval = input.interval === 'MONTH' ? 'month' : 'year';
    const currency = input.currency.toLowerCase();
    const matches = (price: Stripe.Price): boolean =>
      price.livemode === false &&
      price.unit_amount === input.amountMinorUnits &&
      price.currency === currency &&
      price.recurring?.interval === interval &&
      price.recurring?.interval_count === 1 &&
      id(price.product) === input.externalProductId &&
      price.metadata?.centerivo_price_id === input.priceId;
    try {
      const found = await this.stripe.prices.list({
        lookup_keys: [lookupKey],
        limit: 1,
      });
      if (found.data.length > 0) {
        if (!matches(found.data[0])) {
          throw new SaasBillingProviderError('price_mismatch');
        }
        return { externalPriceId: found.data[0].id };
      }
      const created = await this.stripe.prices.create(
        {
          product: input.externalProductId,
          unit_amount: input.amountMinorUnits,
          currency,
          recurring: { interval, interval_count: 1 },
          lookup_key: lookupKey,
          metadata: { centerivo_price_id: input.priceId },
        },
        { idempotencyKey: `centerivo-price-${input.priceId}` },
      );
      if (!matches(created)) {
        throw new SaasBillingProviderError('price_mismatch');
      }
      return { externalPriceId: created.id };
    } catch (error) {
      throw providerError(error);
    }
  }

  async createCustomer(input: {
    idempotencyKey: string;
    tenantId: string;
    businessName: string;
    billingEmail: string;
  }): Promise<{ externalCustomerId: string }> {
    try {
      const customer = await this.stripe.customers.create(
        {
          name: input.businessName.slice(0, 250),
          email: input.billingEmail,
          // Informational only: a webhook never finds a business by this.
          metadata: { centerivo_tenant_id: input.tenantId },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      this.assertTestMode(customer.livemode);
      return { externalCustomerId: customer.id };
    } catch (error) {
      throw providerError(error);
    }
  }

  async createCheckoutSession(input: {
    idempotencyKey: string;
    checkoutSessionId: string;
    tenantId: string;
    externalCustomerId: string;
    externalPriceId: string;
    trialDays: number;
    requiresPaymentMethod: boolean;
    successUrl: string;
    cancelUrl: string;
  }): Promise<ProviderCheckoutSession> {
    const trial = input.trialDays > 0;
    try {
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          customer: input.externalCustomerId,
          line_items: [{ price: input.externalPriceId, quantity: 1 }],
          client_reference_id: input.checkoutSessionId,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          // A cardless trial: no payment method is collected unless one is
          // needed. Otherwise one is always collected.
          payment_method_collection:
            trial && !input.requiresPaymentMethod ? 'if_required' : 'always',
          payment_method_types: [...SUPPORTED_CHECKOUT_PAYMENT_METHOD_TYPES],
          metadata: {
            centerivo_tenant_id: input.tenantId,
            centerivo_checkout_id: input.checkoutSessionId,
          },
          subscription_data: {
            metadata: { centerivo_tenant_id: input.tenantId },
            ...(trial
              ? {
                  trial_period_days: input.trialDays,
                  // F3 / E5: a trial that ends without a payment method is
                  // ENDED by Stripe — never charged.
                  trial_settings: {
                    end_behavior: { missing_payment_method: 'cancel' },
                  },
                }
              : {}),
          },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return this.toCheckout(session);
    } catch (error) {
      throw providerError(error);
    }
  }

  async retrieveCheckoutSession(
    externalSessionId: string,
  ): Promise<ProviderCheckoutSession> {
    try {
      return this.toCheckout(
        await this.stripe.checkout.sessions.retrieve(externalSessionId),
      );
    } catch (error) {
      throw providerError(error);
    }
  }

  private toCheckout(
    session: Stripe.Checkout.Session,
  ): ProviderCheckoutSession {
    this.assertTestMode(session.livemode);
    const status: ProviderCheckoutSession['status'] =
      session.status === 'complete'
        ? 'complete'
        : session.status === 'expired'
          ? 'expired'
          : 'open';
    return {
      externalSessionId: session.id,
      status,
      url: status === 'open' ? (session.url ?? null) : null,
      expiresAt: date(session.expires_at),
      externalCustomerId: id(session.customer),
      externalSubscriptionId: id(session.subscription),
      livemode: session.livemode,
    };
  }

  async retrieveSubscription(
    externalSubscriptionId: string,
  ): Promise<ProviderSubscriptionSnapshot> {
    try {
      // The customer is expanded: its default payment method counts too.
      const sub = await this.stripe.subscriptions.retrieve(
        externalSubscriptionId,
        { expand: ['customer'] },
      );
      return this.toSnapshot(sub);
    } catch (error) {
      throw providerError(error);
    }
  }

  private toSnapshot(sub: Stripe.Subscription): ProviderSubscriptionSnapshot {
    this.assertTestMode(sub.livemode);
    if (typeof sub.customer === 'object' && 'livemode' in sub.customer) {
      this.assertTestMode(sub.customer.livemode);
    }
    const source = paymentMethodSource(sub);
    const status = SUBSCRIPTION_STATUSES.includes(
      sub.status as ProviderSubscriptionStatus,
    )
      ? (sub.status as ProviderSubscriptionStatus)
      : 'incomplete';
    const customer = id(sub.customer);
    if (!customer) throw new SaasBillingProviderError('subscription_customer');
    return {
      externalSubscriptionId: sub.id,
      externalCustomerId: customer,
      status,
      livemode: sub.livemode,
      hasPaymentMethod: source !== null,
      paymentMethodSource: source,
      cancelAtPeriodEnd: sub.cancel_at_period_end === true,
      trialStart: date(sub.trial_start),
      trialEnd: date(sub.trial_end),
      latestInvoiceId: id(sub.latest_invoice),
      // SC3d-1 — what Stripe bills. An item list that is truncated is not
      // trusted (fails closed upstream: one item is expected).
      items: sub.items?.has_more
        ? []
        : (sub.items?.data ?? []).map((item) => ({
            externalItemId: item.id,
            externalPriceId: id(item.price),
            quantity: typeof item.quantity === 'number' ? item.quantity : 1,
          })),
      scheduleId: id(sub.schedule),
      hasPendingUpdate:
        sub.pending_update !== null && sub.pending_update !== undefined,
      currentPeriodEnd: date(sub.items?.data?.[0]?.current_period_end),
      currentPeriodStart: date(sub.items?.data?.[0]?.current_period_start),
    };
  }

  // --- SC3d-1: plan changes -------------------------------------------------------

  // Stripe's preview of an update (nothing is created). The proration date is
  // the one the real update must reuse, so the charge is computed the same way.
  async previewImmediateChange(input: {
    externalSubscriptionId: string;
    externalItemId: string;
    toExternalPriceId: string;
    prorationDate: Date;
  }): Promise<ProviderChargePreview> {
    try {
      const invoice = await this.stripe.invoices.createPreview({
        subscription: input.externalSubscriptionId,
        subscription_details: {
          items: [{ id: input.externalItemId, price: input.toExternalPriceId }],
          proration_behavior: 'always_invoice',
          proration_date: seconds(input.prorationDate),
        },
      });
      this.assertTestMode(invoice.livemode);
      // Every line is needed to total the proration: a truncated preview is
      // not trusted.
      if (invoice.lines?.has_more) {
        throw new SaasBillingProviderError('preview_lines_truncated');
      }
      const currency = text(invoice.currency, 3);
      if (!currency) throw new SaasBillingProviderError('preview_currency');
      return {
        livemode: invoice.livemode,
        currency,
        amountDueMinorUnits: amount(invoice.amount_due),
        totalMinorUnits: signedAmount(invoice.total),
        taxMinorUnits: sum((invoice.total_taxes ?? []).map((t) => t.amount)),
        discountMinorUnits: sum(
          (invoice.total_discount_amounts ?? []).map((d) => d.amount),
        ),
        prorationMinorUnits: sum(
          (invoice.lines?.data ?? [])
            .filter(
              (line) =>
                line.parent?.subscription_item_details?.proration === true,
            )
            .map((line) => line.amount),
        ),
      };
    } catch (error) {
      throw providerError(error);
    }
  }

  // Stripe's estimate of the long-term recurring bill after the change.
  async previewRecurring(input: {
    externalSubscriptionId: string;
    externalItemId: string;
    toExternalPriceId: string;
  }): Promise<ProviderRecurringPreview> {
    try {
      const invoice = await this.stripe.invoices.createPreview({
        subscription: input.externalSubscriptionId,
        preview_mode: 'recurring',
        subscription_details: {
          items: [{ id: input.externalItemId, price: input.toExternalPriceId }],
        },
      });
      this.assertTestMode(invoice.livemode);
      const currency = text(invoice.currency, 3);
      if (!currency) throw new SaasBillingProviderError('preview_currency');
      return {
        livemode: invoice.livemode,
        currency,
        totalMinorUnits: signedAmount(invoice.total),
      };
    } catch (error) {
      throw providerError(error);
    }
  }

  // Applied by Stripe only if the invoice it creates is PAID (a pending update
  // otherwise — nothing changes), prorated and invoiced at once, at the
  // previewed proration date. Idempotent per operation.
  async changePriceNow(input: {
    idempotencyKey: string;
    externalSubscriptionId: string;
    externalItemId: string;
    toExternalPriceId: string;
    prorationDate: Date;
  }): Promise<ProviderPriceChangeResult> {
    try {
      const sub = await this.stripe.subscriptions.update(
        input.externalSubscriptionId,
        {
          items: [{ id: input.externalItemId, price: input.toExternalPriceId }],
          proration_behavior: 'always_invoice',
          proration_date: seconds(input.prorationDate),
          payment_behavior: 'pending_if_incomplete',
          expand: ['customer'],
        },
        { idempotencyKey: input.idempotencyKey },
      );
      const snapshot = this.toSnapshot(sub);
      return {
        snapshot,
        externalInvoiceId: snapshot.latestInvoiceId,
        pendingUpdate: snapshot.hasPendingUpdate === true,
      };
    } catch (error) {
      throw providerError(error);
    }
  }

  // A schedule built from the subscription: the current price until the end
  // of the current period, then the new one; the schedule then RELEASES the
  // subscription (it continues on the new price). Never prorated.
  async schedulePriceChangeAtPeriodEnd(input: {
    idempotencyKey: string;
    externalSubscriptionId: string;
    fromExternalPriceId: string;
    toExternalPriceId: string;
    toInterval: 'MONTH' | 'YEAR';
  }): Promise<{ externalScheduleId: string }> {
    try {
      const created = await this.stripe.subscriptionSchedules.create(
        { from_subscription: input.externalSubscriptionId },
        { idempotencyKey: `${input.idempotencyKey}-create` },
      );
      this.assertTestMode(created.livemode);
      const current = created.phases?.[0];
      if (
        !current ||
        typeof current.start_date !== 'number' ||
        typeof current.end_date !== 'number'
      ) {
        throw new SaasBillingProviderError('schedule_phase_unreadable');
      }
      // SC3d-3 — Stripe UNSETS every current-phase setting an update omits
      // (a trial would end at once). The current phase is passed back as it
      // is — its trial end included — or, when it carries settings we do not
      // reproduce, the new schedule is released (the subscription untouched)
      // and nothing is changed.
      const phase0 = currentPhaseParams(current, input.fromExternalPriceId);
      if (phase0 === null) {
        await this.stripe.subscriptionSchedules.release(created.id, {
          preserve_cancel_date: true,
        });
        throw new SaasBillingProviderError('schedule_phase_unsupported');
      }
      const updated = await this.stripe.subscriptionSchedules.update(
        created.id,
        {
          end_behavior: 'release',
          phases: [
            phase0,
            {
              // The same payment, tax, invoice, discount and metadata
              // settings as now (what the recurring preview priced) — never
              // the trial end.
              ...carriedSettings(phase0),
              items: [{ price: input.toExternalPriceId, quantity: 1 }],
              duration: {
                interval: input.toInterval === 'YEAR' ? 'year' : 'month',
                interval_count: 1,
              },
              proration_behavior: 'none',
            },
          ],
        },
        { idempotencyKey: `${input.idempotencyKey}-phases` },
      );
      this.assertTestMode(updated.livemode);
      return { externalScheduleId: updated.id };
    } catch (error) {
      throw providerError(error);
    }
  }

  // SC3d-3 — a schedule as Stripe holds it (null: none).
  async retrieveSchedule(
    externalScheduleId: string,
  ): Promise<ProviderSchedule | null> {
    try {
      const schedule =
        await this.stripe.subscriptionSchedules.retrieve(externalScheduleId);
      this.assertTestMode(schedule.livemode);
      return {
        externalScheduleId: schedule.id,
        livemode: schedule.livemode,
        status: text(schedule.status, 40) ?? 'unknown',
        externalSubscriptionId:
          id(schedule.subscription) ?? id(schedule.released_subscription),
        phases: (schedule.phases ?? []).map((phase) => ({
          externalPriceId:
            phase.items?.length === 1 ? id(phase.items[0].price) : null,
          quantity:
            phase.items?.length === 1 &&
            typeof phase.items[0].quantity === 'number'
              ? phase.items[0].quantity
              : 0,
          startDate: date(phase.start_date),
          endDate: date(phase.end_date),
          trialEnd: date(phase.trial_end),
        })),
      };
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'resource_missing') {
        return null;
      }
      throw providerError(error);
    }
  }

  // RELEASE (never cancel — cancelling a schedule cancels its subscription):
  // the schedule stops, the subscription stays exactly as it is.
  async releaseSchedule(input: {
    idempotencyKey: string;
    externalScheduleId: string;
  }): Promise<{ releasedSubscriptionId: string | null }> {
    try {
      const released = await this.stripe.subscriptionSchedules.release(
        input.externalScheduleId,
        { preserve_cancel_date: true },
        { idempotencyKey: input.idempotencyKey },
      );
      this.assertTestMode(released.livemode);
      return { releasedSubscriptionId: id(released.released_subscription) };
    } catch (error) {
      throw providerError(error);
    }
  }

  async retrieveInvoice(
    externalInvoiceId: string,
  ): Promise<ProviderInvoice | null> {
    try {
      const invoice = await this.stripe.invoices.retrieve(externalInvoiceId);
      this.assertTestMode(invoice.livemode);
      const status = INVOICE_STATUSES.includes(
        invoice.status as ProviderInvoiceStatus,
      )
        ? (invoice.status as ProviderInvoiceStatus)
        : 'open';
      return {
        externalInvoiceId: invoice.id ?? externalInvoiceId,
        status,
        externalSubscriptionId: invoiceSubscription(invoice),
        externalCustomerId: id(invoice.customer),
        livemode: invoice.livemode,
        amountPaidMinorUnits: amount(invoice.amount_paid),
        billingReason: text(invoice.billing_reason, 60),
        currency: text(invoice.currency, 3),
      };
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'resource_missing') {
        return null;
      }
      throw providerError(error);
    }
  }

  // SC3c-2 — the subscription's open invoices (oldest first). Only test-mode
  // invoices of THIS subscription are returned.
  async listOpenInvoices(
    externalSubscriptionId: string,
  ): Promise<ProviderPayableInvoice[]> {
    try {
      // Every open invoice (up to a hard cap): one that cannot be read
      // still counts as outstanding (its subscription is then unknown and it
      // is never OFFERED, but it blocks a restoration).
      const all = await this.stripe.invoices
        .list({
          subscription: externalSubscriptionId,
          status: 'open',
          limit: 100,
        })
        .autoPagingToArray({ limit: OPEN_INVOICE_CAP });
      return all
        .map((invoice) => {
          this.assertTestMode(invoice.livemode);
          return {
            externalInvoiceId: invoice.id ?? '',
            status: 'open' as const,
            externalSubscriptionId: invoiceSubscription(invoice),
            externalCustomerId: id(invoice.customer),
            livemode: invoice.livemode,
            amountPaidMinorUnits: amount(invoice.amount_paid),
            amountDueMinorUnits: amount(invoice.amount_due),
            currency: text(invoice.currency, 3) ?? '',
            createdAt: date(invoice.created) ?? new Date(0),
            hostedInvoiceUrl: text(invoice.hosted_invoice_url, 2048),
          };
        })
        .filter(
          (invoice) =>
            invoice.externalSubscriptionId === null ||
            invoice.externalSubscriptionId === externalSubscriptionId,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    } catch (error) {
      throw providerError(error);
    }
  }

  get portalConfigurationId(): string | null {
    return this.config.portalConfigurationId ?? null;
  }

  get expectedAccountId(): string | null {
    return this.config.expectedAccountId ?? null;
  }

  async retrievePortalConfiguration(
    configurationId: string,
  ): Promise<ProviderPortalConfiguration> {
    try {
      const [config, account] = await Promise.all([
        this.stripe.billingPortal.configurations.retrieve(configurationId),
        this.stripe.accounts.retrieveCurrent(),
      ]);
      this.assertTestMode(config.livemode);
      return {
        configurationId: config.id,
        accountId: account.id,
        livemode: config.livemode,
        active: config.active,
        paymentMethodUpdate: config.features.payment_method_update.enabled,
        invoiceHistory: config.features.invoice_history.enabled,
        subscriptionCancel: config.features.subscription_cancel.enabled,
        subscriptionUpdate: config.features.subscription_update.enabled,
        customerUpdate: config.features.customer_update.enabled,
        loginPage: config.login_page.enabled,
        otherEnabledFeatures: Object.entries(
          config.features as unknown as Record<string, unknown>,
        )
          .filter(
            ([name, feature]) =>
              !KNOWN_PORTAL_FEATURES.has(name) &&
              typeof feature === 'object' &&
              feature !== null &&
              (feature as { enabled?: unknown }).enabled === true,
          )
          .map(([name]) => name),
      };
    } catch (error) {
      throw providerError(error);
    }
  }

  async createPortalSession(input: {
    externalCustomerId: string;
    configurationId: string;
    returnUrl: string;
  }): Promise<{ url: string; livemode: boolean }> {
    try {
      const session = await this.stripe.billingPortal.sessions.create({
        customer: input.externalCustomerId,
        configuration: input.configurationId,
        return_url: input.returnUrl,
      });
      this.assertTestMode(session.livemode);
      return { url: session.url, livemode: session.livemode };
    } catch (error) {
      throw providerError(error);
    }
  }

  verifyEvent(input: {
    rawBody: string | Buffer;
    signatureHeader: string | undefined;
    now?: Date;
  }): VerifiedBillingProviderEvent {
    if (
      typeof input.signatureHeader !== 'string' ||
      input.signatureHeader.length > 2000
    ) {
      throw new BillingEventVerificationError('Missing signature.');
    }
    let event: Stripe.Event;
    try {
      // The ORIGINAL raw bytes: a re-serialized body would not verify.
      event = this.stripe.webhooks.constructEvent(
        input.rawBody,
        input.signatureHeader,
        this.config.webhookSecret,
        STRIPE_SIGNATURE_TOLERANCE_SECONDS,
        undefined,
        input.now ? Math.floor(input.now.getTime() / 1000) : undefined,
      );
    } catch {
      throw new BillingEventVerificationError('Invalid signature.');
    }
    const occurredAt = date(event.created);
    if (!text(event.id) || !text(event.type, 100) || !occurredAt) {
      throw new BillingEventVerificationError('Incomplete event.');
    }
    const object = event.data.object as unknown as Record<string, unknown>;
    const normalized = normalize(event.type, object);
    return {
      provider: PROVIDER,
      externalEventId: event.id,
      providerType: event.type,
      livemode: event.livemode,
      occurredAt,
      // Stable content only: never delivery counters such as
      // pending_webhooks or the request block.
      payloadDigest: createHash('sha256')
        .update(
          JSON.stringify({
            id: event.id,
            type: event.type,
            created: event.created,
            livemode: event.livemode,
            object: event.data.object,
          }),
        )
        .digest('hex'),
      externalSubscriptionId: normalized.externalSubscriptionId,
      externalCustomerId: id(object.customer),
      claimedTenantId: metadataTenant(object),
      event: normalized.event,
    };
  }
}

function invoiceSubscription(invoice: unknown): string | null {
  const record = invoice as {
    parent?: {
      subscription_details?: { subscription?: unknown } | null;
    } | null;
    subscription?: unknown;
  };
  return (
    id(record.parent?.subscription_details?.subscription) ??
    id(record.subscription)
  );
}

function metadataTenant(object: Record<string, unknown>): string | null {
  const metadata = object.metadata as Record<string, unknown> | undefined;
  return text(metadata?.centerivo_tenant_id, 64);
}

function normalize(
  type: string,
  object: Record<string, unknown>,
): { event: ProviderLifecycleEvent; externalSubscriptionId: string | null } {
  switch (type) {
    case 'checkout.session.completed': {
      const sessionId = text(object.id);
      return object.mode === 'subscription' && sessionId
        ? {
            event: { kind: 'CHECKOUT_COMPLETED', externalSessionId: sessionId },
            externalSubscriptionId: id(object.subscription),
          }
        : { event: { kind: 'UNSUPPORTED' }, externalSubscriptionId: null };
    }
    // SC3d-2 — pending_update_applied / _expired: a plan change waiting for
    // payment was applied (paid) or discarded: re-read live, like any
    // subscription change.
    // SC3d-3 — a schedule changed (created, updated, released, canceled,
    // completed, aborted): re-read the subscription it manages.
    case 'subscription_schedule.created':
    case 'subscription_schedule.updated':
    case 'subscription_schedule.released':
    case 'subscription_schedule.canceled':
    case 'subscription_schedule.completed':
    case 'subscription_schedule.aborted':
    case 'subscription_schedule.expiring':
      return {
        event: { kind: 'SUBSCRIPTION_CHANGED' },
        externalSubscriptionId:
          id(object.subscription) ?? id(object.released_subscription),
      };
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.pending_update_applied':
    case 'customer.subscription.pending_update_expired':
      return {
        event: { kind: 'SUBSCRIPTION_CHANGED' },
        externalSubscriptionId: text(object.id),
      };
    case 'invoice.paid': {
      const reference = text(object.id);
      const amount = object.amount_paid;
      const currency = text(object.currency, 3);
      const line = (
        object.lines as {
          data?: Array<{ period?: { start?: unknown; end?: unknown } }>;
        }
      )?.data?.[0];
      return reference &&
        currency &&
        typeof amount === 'number' &&
        Number.isInteger(amount) &&
        amount >= 0
        ? {
            event: {
              kind: 'PAYMENT_SUCCEEDED',
              reference,
              amountMinorUnits: amount,
              currency: currency.toUpperCase(),
              periodStart: date(line?.period?.start),
              periodEnd: date(line?.period?.end),
            },
            externalSubscriptionId: invoiceSubscription(object),
          }
        : { event: { kind: 'UNSUPPORTED' }, externalSubscriptionId: null };
    }
    case 'invoice.payment_failed': {
      const reference = text(object.id);
      return reference
        ? {
            event: { kind: 'PAYMENT_FAILED', reference },
            externalSubscriptionId: invoiceSubscription(object),
          }
        : { event: { kind: 'UNSUPPORTED' }, externalSubscriptionId: null };
    }
    default:
      return { event: { kind: 'UNSUPPORTED' }, externalSubscriptionId: null };
  }
}
