import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  BILLING_ALREADY_SET_UP,
  BILLING_CHECKOUT_IN_PROGRESS,
  BILLING_CHECKOUT_PROCESSING,
  BILLING_NOT_BILLED,
  BILLING_NOTHING_TO_PAY,
  BILLING_RECOVERY_UNDER_REVIEW,
  BILLING_SUBSCRIPTION_NOT_ENDED,
  BILLING_TRIAL_PENDING_ELSEWHERE,
  BILLING_UNAVAILABLE,
  PLATFORM_ALREADY_BILLED,
  PLATFORM_FOUNDING_COMPLIMENTARY,
  PLATFORM_NO_OWNER,
  PLATFORM_PRICE_NOT_ACTIVE,
  PLATFORM_PRICE_NOT_FOR_PLAN,
  PLATFORM_ADMINISTRATOR_ROLE,
  type BusinessBillingSummary,
  type PlatformTenantBillingResponse,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import { UNLINKED_REPLACEMENT_CASE } from './billing-lifecycle.service';
import { portalConfigurationRefusal } from '../provider/portal-configuration';
import { entitledToPlanModules } from '../domain/billing-lifecycle';
import { billingEnforcementEnabled } from './billing-enforcement.config';
import { runSerializable } from '../../prisma/serializable-transaction';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import type { PlatformOperatorRow } from '../../platform-auth/infrastructure/platform-identity';
import { isUuid } from '../../platform-subscriptions/application/plan-input';
import {
  SAAS_BILLING_PROVIDER,
  SaasBillingProviderError,
  type ProviderCheckoutSession,
  type ProviderPayableInvoice,
  type SaasBillingProvider,
} from '../provider/saas-billing-provider';
import {
  DEFAULT_BILLING_POLICY_ID,
  TRIAL_CLAIM_SECRET_ENV,
  trialClaimKey,
} from './billing-lifecycle.service';

// SC3b — starting billing (platform operator, E10/F2) and payment setup
// through hosted Checkout (the business owner, F2). Every identifier comes
// from OUR records: the business from the trusted request context (the
// operator's route parameter, checked; the owner's authenticated business),
// the price from the subscription's agreed price, the provider customer and
// product/price ids from our rows. Nothing provider-side is taken from the
// client. No money moves here: Checkout is the provider's hosted page.

const SUBSCRIPTION_INCLUDE = {
  planVersion: { include: { plan: true } },
  planPrice: true,
  subscriberTenant: {
    select: { id: true, name: true, status: true, suspensionReason: true },
  },
} as const satisfies Prisma.TenantSubscriptionInclude;

type SubscriptionView = Prisma.TenantSubscriptionGetPayload<{
  include: typeof SUBSCRIPTION_INCLUDE;
}>;

// An OPEN Checkout row with no provider session yet older than this is an
// abandoned creation (a crash between our row and the provider call).
const ABANDONED_CREATION_MS = 2 * 60 * 1000;

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

function trialPendingElsewhere(): ConflictException {
  return conflict(
    BILLING_TRIAL_PENDING_ELSEWHERE,
    "A free trial is being set up for another of this owner's businesses. Finish or leave that payment setup, then try again.",
  );
}

function nothingToPay(): ConflictException {
  return conflict(
    BILLING_NOTHING_TO_PAY,
    "There's no outstanding invoice to pay right now.",
  );
}

// SC3c-2 — only the billing provider's OWN hosted pages are ever handed to
// the browser (invoice payment / Customer Portal). The fake provider's only
// for the fake.
export function isProviderPage(
  value: string,
  provider: string,
  kind: 'invoice' | 'portal',
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host =
    provider === 'stripe'
      ? kind === 'invoice'
        ? 'invoice.stripe.com'
        : 'billing.stripe.com'
      : provider === 'fake'
        ? kind === 'invoice'
          ? 'invoice.fake.test'
          : 'billing.fake.test'
        : null;
  return host !== null && url.hostname === host;
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: 503,
    error: 'Service Unavailable',
    code: BILLING_UNAVAILABLE,
    message: 'Billing is not available right now. Nothing was changed.',
  });
}

export function billingSummary(row: SubscriptionView): BusinessBillingSummary {
  const enforced = billingEnforcementEnabled();
  const state: BusinessBillingSummary['state'] =
    row.billingMode === 'COMPLIMENTARY'
      ? 'COMPLIMENTARY'
      : row.externalSubscriptionId === null
        ? 'AWAITING_SETUP'
        : row.status;
  return {
    state,
    planName: row.planVersion.plan.name,
    price: row.planPrice
      ? {
          amountMinorUnits: row.planPrice.amountMinorUnits,
          currency: row.planPrice.currency,
          interval: row.planPrice.interval,
        }
      : null,
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    graceEndsAt: row.graceEndsAt?.toISOString() ?? null,
    recoveryEndsAt: row.recoveryEndsAt?.toISOString() ?? null,
    enforced,
    premiumPaused:
      enforced && row.billingMode === 'BILLED' && !entitledToPlanModules(row),
    suspendedForBilling:
      row.subscriberTenant.status === 'SUSPENDED' &&
      row.subscriberTenant.suspensionReason === 'BILLING',
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    paymentMethodOnFile: row.recurringPaymentAuthorizedAt !== null,
  };
}

// The configured return page for Checkout (the business admin's billing
// page). Server configuration only — never a client value.
export function checkoutReturnUrl(
  env: Record<string, string | undefined> = process.env,
): URL | null {
  const raw = env.BILLING_CHECKOUT_RETURN_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

@Injectable()
export class BillingAccountService {
  private readonly logger = new Logger(BillingAccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SAAS_BILLING_PROVIDER)
    private readonly provider: SaasBillingProvider,
    private readonly audit: InternalAuditService,
  ) {}

  // --- SC3c-2: recovery ---------------------------------------------------------

  // Which recovery actions the business's billing allows now (the caller
  // adds the billing.manage check).
  recoveryActions(billing: BusinessBillingSummary): {
    restart: boolean;
    payInvoice: boolean;
    portal: boolean;
  } {
    const linked =
      billing.state !== 'COMPLIMENTARY' && billing.state !== 'AWAITING_SETUP';
    return {
      restart:
        billing.state === 'TRIAL_EXPIRED' || billing.state === 'CANCELED',
      payInvoice: billing.state === 'PAST_DUE' || billing.state === 'UNPAID',
      // An ended subscription is restarted, not edited.
      portal:
        linked &&
        billing.state !== 'TRIAL_EXPIRED' &&
        billing.state !== 'CANCELED' &&
        this.provider.available &&
        this.provider.portalConfigurationId !== null &&
        this.provider.expectedAccountId !== null,
    };
  }

  // The provider's hosted page for the business's OLDEST outstanding
  // invoice. Found from OUR stored subscription and customer and verified
  // (subscription, customer, test mode, open, something due, the provider's
  // own page) — no client value is read.
  async payInvoice(
    tenantId: string,
    actorInternalUserId: string,
  ): Promise<{ url: string }> {
    if (!this.provider.available) throw unavailable();
    const subscription = await this.linkedSubscription(tenantId);
    if (
      subscription.status !== 'PAST_DUE' &&
      subscription.status !== 'UNPAID'
    ) {
      throw nothingToPay();
    }
    let invoices: ProviderPayableInvoice[];
    try {
      invoices = await this.provider.listOpenInvoices(
        subscription.externalSubscriptionId!,
      );
    } catch (error) {
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }
    const payable = invoices.find(
      (invoice) =>
        invoice.status === 'open' &&
        !invoice.livemode &&
        invoice.externalSubscriptionId ===
          subscription.externalSubscriptionId &&
        invoice.externalCustomerId === subscription.externalCustomerId &&
        invoice.amountDueMinorUnits > 0 &&
        invoice.hostedInvoiceUrl !== null &&
        isProviderPage(invoice.hostedInvoiceUrl, this.provider.name, 'invoice'),
    );
    if (!payable) throw nothingToPay();
    await this.prisma.$transaction((tx) =>
      this.audit.recordBillingRecoveryStarted(tx, {
        actorInternalUserId,
        subscriptionId: subscription.id,
        kind: 'INVOICE_PAYMENT',
        reference: payable.externalInvoiceId,
      }),
    );
    return { url: payable.hostedInvoiceUrl! };
  }

  // A Customer Portal session for the business's OWN provider customer,
  // under the operator-configured configuration — re-read and checked
  // first (payment methods and invoices only; never subscription changes).
  async openPortal(
    tenantId: string,
    actorInternalUserId: string,
  ): Promise<{ url: string }> {
    const configurationId = this.provider.portalConfigurationId;
    const accountId = this.provider.expectedAccountId;
    if (!this.provider.available || !configurationId || !accountId) {
      throw unavailable();
    }
    const returnUrl = checkoutReturnUrl();
    if (!returnUrl) throw unavailable();
    const subscription = await this.linkedSubscription(tenantId);
    let url: string;
    try {
      const config =
        await this.provider.retrievePortalConfiguration(configurationId);
      const refusal = portalConfigurationRefusal(config, {
        configurationId,
        accountId,
      });
      if (refusal !== null) {
        this.logger.warn(`Customer Portal refused: configuration ${refusal}.`);
        throw unavailable();
      }
      const back = new URL(returnUrl);
      back.searchParams.set('portal', 'returned');
      const session = await this.provider.createPortalSession({
        externalCustomerId: subscription.externalCustomerId!,
        configurationId,
        returnUrl: back.toString(),
      });
      if (
        session.livemode ||
        !isProviderPage(session.url, this.provider.name, 'portal')
      ) {
        throw unavailable();
      }
      url = session.url;
    } catch (error) {
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }
    await this.prisma.$transaction((tx) =>
      this.audit.recordBillingRecoveryStarted(tx, {
        actorInternalUserId,
        subscriptionId: subscription.id,
        kind: 'PAYMENT_METHOD_PORTAL',
        reference: null,
      }),
    );
    return { url };
  }

  // The business's BILLED subscription, linked to its provider customer and
  // subscription (recovery needs both).
  private async linkedSubscription(tenantId: string) {
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { subscriberTenantId: tenantId },
    });
    if (
      !subscription ||
      subscription.billingMode !== 'BILLED' ||
      subscription.externalSubscriptionId === null ||
      subscription.externalCustomerId === null
    ) {
      throw conflict(
        BILLING_NOT_BILLED,
        'This business has no billing to recover.',
      );
    }
    if (subscription.billingProvider !== this.provider.name) {
      throw unavailable();
    }
    return subscription;
  }

  // --- reads ------------------------------------------------------------------

  async summaryForTenant(
    tenantId: string,
  ): Promise<BusinessBillingSummary | null> {
    const row = await this.prisma.tenantSubscription.findUnique({
      where: { subscriberTenantId: tenantId },
      include: SUBSCRIPTION_INCLUDE,
    });
    return row ? billingSummary(row) : null;
  }

  async platformView(tenantId: string): Promise<PlatformTenantBillingResponse> {
    if (!isUuid(tenantId)) throw new NotFoundException('Business not found.');
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) throw new NotFoundException('Business not found.');
    return { tenantId, billing: await this.summaryForTenant(tenantId) };
  }

  // --- operator: start billing ------------------------------------------------

  // A COMPLIMENTARY, non-Founding business starts being billed at one ACTIVE
  // price of its CURRENT plan. Creates the provider customer (deterministic
  // idempotency key: the same subscription never gets two customers), then
  // records BILLED + the agreed price with a compare-and-set. Nothing is
  // charged: the owner sets up payment through Checkout.
  async startBilling(
    tenantId: string,
    planPriceId: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformTenantBillingResponse> {
    if (!isUuid(tenantId) || !isUuid(planPriceId)) {
      throw new NotFoundException('Business or price not found.');
    }
    if (!this.provider.available) throw unavailable();
    const { subscription, owner, price } = await this.startBillingChecks(
      tenantId,
      planPriceId,
    );

    let externalCustomerId: string;
    try {
      ({ externalCustomerId } = await this.provider.createCustomer({
        idempotencyKey: `centerivo-customer-${subscription.id}`,
        tenantId,
        businessName: subscription.subscriberTenant.name,
        billingEmail: owner.email,
      }));
    } catch (error) {
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }

    await runSerializable(this.prisma, async (tx) => {
      const { count } = await tx.tenantSubscription.updateMany({
        where: {
          id: subscription.id,
          billingMode: 'COMPLIMENTARY',
          billingStateVersion: subscription.billingStateVersion,
        },
        data: {
          billingMode: 'BILLED',
          billingProvider: this.provider.name,
          externalCustomerId,
          planPriceId: price.id,
          // The SC2a informational status is reset: billing state starts here.
          status: 'ACTIVE',
          billingStateVersion: { increment: 1 },
        },
      });
      if (count !== 1) {
        throw conflict(
          PLATFORM_ALREADY_BILLED,
          'This business is already billed.',
        );
      }
      await tx.platformAuditEvent.create({
        data: {
          action: PLATFORM_AUDIT_ACTIONS.tenantBillingStarted,
          outcome: 'SUCCEEDED',
          actorPlatformOperatorId: operator.id,
          targetType: 'tenant',
          targetId: tenantId,
          requestReference: requestReference ?? null,
        },
      });
    });
    return this.platformView(tenantId);
  }

  private async startBillingChecks(tenantId: string, planPriceId: string) {
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { subscriberTenantId: tenantId },
      include: SUBSCRIPTION_INCLUDE,
    });
    if (!subscription) throw new NotFoundException('Business not found.');
    if (subscription.billingMode !== 'COMPLIMENTARY') {
      throw conflict(
        PLATFORM_ALREADY_BILLED,
        'This business is already billed.',
      );
    }
    // E3: Founding businesses stay complimentary.
    if (subscription.planVersion.plan.key === 'founding') {
      throw conflict(
        PLATFORM_FOUNDING_COMPLIMENTARY,
        'Founding businesses are complimentary and are never billed.',
      );
    }
    const price = await this.prisma.subscriptionPlanPrice.findUnique({
      where: { id: planPriceId },
    });
    if (!price) throw new NotFoundException('Business or price not found.');
    if (price.planId !== subscription.planVersion.planId) {
      throw conflict(
        PLATFORM_PRICE_NOT_FOR_PLAN,
        "That price is not one of this business's plan's prices.",
      );
    }
    if (price.status !== 'ACTIVE') {
      throw conflict(
        PLATFORM_PRICE_NOT_ACTIVE,
        'That price is no longer offered.',
      );
    }
    const owner = await this.prisma.internalUser.findFirst({
      where: {
        tenantId,
        roleAssignments: {
          some: {
            scopeType: 'CORPORATE',
            scopeId: null,
            role: { key: PLATFORM_ADMINISTRATOR_ROLE.key },
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { email: true },
    });
    if (!owner?.email) {
      throw conflict(PLATFORM_NO_OWNER, 'This business has no owner to bill.');
    }
    return { subscription, owner: { email: owner.email }, price };
  }

  // --- owner: payment setup (hosted Checkout) ----------------------------------

  // Opens (or reuses) the ONE Checkout for the signed-in business. The
  // business is the authenticated one; the price is its agreed price; the
  // trial is decided here from the billing policy and the one-trial claims.
  async openCheckout(
    tenantId: string,
    ownerEmail: string,
    actorInternalUserId: string | null = null,
  ): Promise<{ url: string }> {
    if (!this.provider.available) throw unavailable();
    const returnUrl = checkoutReturnUrl();
    if (!returnUrl) throw unavailable();

    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { subscriberTenantId: tenantId },
      include: SUBSCRIPTION_INCLUDE,
    });
    if (!subscription || subscription.billingMode !== 'BILLED') {
      throw conflict(
        BILLING_NOT_BILLED,
        'This business has no billing to set up.',
      );
    }
    // SC3c-2 — a business whose subscription ENDED (expired trial or
    // canceled) restarts it with a new Checkout; anything else that is
    // already linked is set up.
    const replaces = subscription.externalSubscriptionId;
    if (
      replaces !== null &&
      subscription.status !== 'TRIAL_EXPIRED' &&
      subscription.status !== 'CANCELED'
    ) {
      throw conflict(BILLING_ALREADY_SET_UP, 'Payment is already set up.');
    }
    if (
      subscription.billingProvider !== this.provider.name ||
      subscription.externalCustomerId === null ||
      subscription.planPrice === null
    ) {
      throw unavailable();
    }

    // An open Checkout is reused, never duplicated.
    const reused = await this.reuseOpenCheckout(subscription.id);
    if (reused) return reused;

    // A restart: the old provider subscription must really have ENDED
    // (read live), and it is never offered a trial.
    if (replaces !== null) {
      let ended: boolean;
      try {
        const old = await this.provider.retrieveSubscription(replaces);
        if (
          old.livemode ||
          old.externalCustomerId !== subscription.externalCustomerId
        ) {
          throw unavailable();
        }
        ended =
          old.status === 'canceled' || old.status === 'incomplete_expired';
      } catch (error) {
        if (error instanceof SaasBillingProviderError) throw unavailable();
        throw error;
      }
      if (!ended) {
        throw conflict(
          BILLING_SUBSCRIPTION_NOT_ENDED,
          'Your previous subscription has not ended yet. Try again in a moment.',
        );
      }
    }

    const externalPriceId = await this.syncPrice(subscription);
    const trial =
      replaces !== null
        ? { trialDays: 0, requiresPaymentMethod: true, claimKey: null }
        : await this.offeredTrial(subscription, ownerEmail);

    // Our row first: the partial unique index allows ONE open Checkout per
    // subscription, so concurrent requests cannot both create one.
    // Opening Checkout never consumes the one-time trial: the row only HOLDS
    // the owner's claim while it is OPEN (a second partial unique index
    // allows one such hold per claim). The claim is recorded when the
    // provider has verifiably created the trial subscription (webhook).
    let checkoutId: string;
    try {
      checkoutId = await runSerializable(this.prisma, async (tx) => {
        // SC3c-2 — a restart only while the business still holds the ended
        // subscription it replaces (a concurrent replacement wins).
        if (replaces !== null) {
          const current = await tx.tenantSubscription.findUniqueOrThrow({
            where: { id: subscription.id },
            select: { externalSubscriptionId: true, status: true },
          });
          if (
            current.externalSubscriptionId !== replaces ||
            (current.status !== 'TRIAL_EXPIRED' &&
              current.status !== 'CANCELED')
          ) {
            throw conflict(
              BILLING_ALREADY_SET_UP,
              'Payment is already set up.',
            );
          }
        }
        const row = await tx.billingCheckoutSession.create({
          data: {
            subscriptionId: subscription.id,
            planPriceId: subscription.planPrice!.id,
            trialDays: trial.trialDays,
            requiresPaymentMethod: trial.requiresPaymentMethod,
            trialClaimKey: trial.claimKey,
            replacesExternalSubscriptionId: replaces,
          },
        });
        if (replaces !== null && actorInternalUserId !== null) {
          await this.audit.recordBillingRecoveryStarted(tx, {
            actorInternalUserId,
            subscriptionId: subscription.id,
            kind: 'RESTART_CHECKOUT',
            reference: row.id,
          });
        }
        return row.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        if (
          trial.claimKey !== null &&
          (await this.trialHeldElsewhere(trial.claimKey, subscription.id)) ===
            'HELD'
        ) {
          throw trialPendingElsewhere();
        }
        throw conflict(
          BILLING_CHECKOUT_IN_PROGRESS,
          'Payment setup is already being prepared. Try again in a moment.',
        );
      }
      throw error;
    }

    const success = new URL(returnUrl);
    success.searchParams.set('checkout', 'success');
    const cancel = new URL(returnUrl);
    cancel.searchParams.set('checkout', 'cancelled');
    let session: ProviderCheckoutSession;
    try {
      session = await this.provider.createCheckoutSession({
        idempotencyKey: `centerivo-checkout-${checkoutId}`,
        checkoutSessionId: checkoutId,
        tenantId,
        externalCustomerId: subscription.externalCustomerId,
        externalPriceId,
        trialDays: trial.trialDays,
        requiresPaymentMethod: trial.requiresPaymentMethod,
        successUrl: success.toString(),
        cancelUrl: cancel.toString(),
      });
    } catch (error) {
      // Our OPEN row stays without a provider session; it is treated as
      // abandoned after a short while and a new one can be opened.
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }
    // The provider session must be recorded before its URL is handed out:
    // otherwise its completion could never be matched. If recording fails,
    // no URL is returned (the unrecorded session expires unused) and an
    // operator reviews it.
    let recorded = false;
    try {
      const { count } = await this.prisma.billingCheckoutSession.updateMany({
        where: { id: checkoutId, status: 'OPEN', externalSessionId: null },
        data: {
          externalSessionId: session.externalSessionId,
          expiresAt: session.expiresAt,
        },
      });
      recorded = count === 1;
    } catch {
      recorded = false;
    }
    if (!recorded) {
      await this.prisma.billingReconciliationCase
        .create({
          data: {
            kind: 'CHECKOUT_NOT_RECORDED',
            subscriptionId: subscription.id,
            detail: session.externalSessionId.slice(0, 200),
          },
        })
        .catch(() => undefined); // already open for this business, or the database is down
      throw unavailable();
    }
    if (session.status !== 'open' || !session.url) throw unavailable();
    return { url: session.url };
  }

  private async reuseOpenCheckout(
    subscriptionId: string,
  ): Promise<{ url: string } | null> {
    const open = await this.prisma.billingCheckoutSession.findFirst({
      where: { subscriptionId, status: 'OPEN' },
    });
    if (!open) return null;
    if (open.externalSessionId === null) {
      if (Date.now() - open.createdAt.getTime() < ABANDONED_CREATION_MS) {
        throw conflict(
          BILLING_CHECKOUT_IN_PROGRESS,
          'Payment setup is already being prepared. Try again in a moment.',
        );
      }
      await this.expire(open.id);
      return null;
    }
    let session: ProviderCheckoutSession;
    try {
      session = await this.provider.retrieveCheckoutSession(
        open.externalSessionId,
      );
    } catch (error) {
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }
    if (session.status === 'open' && session.url) return { url: session.url };
    // SC3c-2 — a completed restart that could not be linked: reviewed by an
    // operator first (never a second charge meanwhile). Once the operator
    // has resolved it, this attempt is closed and a new one may start.
    if (session.status === 'complete' && open.replacesExternalSubscriptionId) {
      const review = await this.prisma.billingReconciliationCase.findMany({
        where: {
          kind: UNLINKED_REPLACEMENT_CASE,
          createdAt: { gte: open.createdAt },
          OR: [
            { subscriptionId },
            { billingProviderEvent: { subscriptionId } },
          ],
        },
        select: { status: true },
      });
      if (review.some((item) => item.status === 'OPEN')) {
        throw conflict(
          BILLING_RECOVERY_UNDER_REVIEW,
          "Your payment is being reviewed by our team. You won't be charged again.",
        );
      }
      if (review.length > 0) {
        await this.expire(open.id);
        return null;
      }
    }
    if (session.status === 'complete') {
      // Paid/confirmed at the provider; our webhook will link it.
      throw conflict(
        BILLING_CHECKOUT_PROCESSING,
        "We're confirming your payment setup. This page will update shortly.",
      );
    }
    await this.expire(open.id);
    return null;
  }

  // Whether ANOTHER business's open Checkout holds this trial claim. A hold
  // whose provider session expired (or was never created) is released here;
  // one the owner completed means the trial is being created there.
  private async trialHeldElsewhere(
    claimKey: string,
    subscriptionId: string,
  ): Promise<'FREE' | 'HELD' | 'USED'> {
    const hold = await this.prisma.billingCheckoutSession.findFirst({
      where: {
        trialClaimKey: claimKey,
        status: 'OPEN',
        subscriptionId: { not: subscriptionId },
      },
    });
    if (!hold) return 'FREE';
    if (hold.externalSessionId === null) {
      if (Date.now() - hold.createdAt.getTime() < ABANDONED_CREATION_MS) {
        return 'HELD';
      }
      await this.expire(hold.id);
      return 'FREE';
    }
    let session: ProviderCheckoutSession;
    try {
      session = await this.provider.retrieveCheckoutSession(
        hold.externalSessionId,
      );
    } catch (error) {
      // A session the provider no longer has holds nothing; any other
      // provider error is transient (try again later).
      if (
        error instanceof SaasBillingProviderError &&
        error.code === 'resource_missing'
      ) {
        await this.expire(hold.id);
        return 'FREE';
      }
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }
    if (session.status === 'open') return 'HELD';
    if (session.status === 'complete') return 'USED';
    await this.expire(hold.id);
    return 'FREE';
  }

  private async expire(checkoutId: string): Promise<void> {
    await this.prisma.billingCheckoutSession.updateMany({
      where: { id: checkoutId, status: 'OPEN' },
      data: { status: 'EXPIRED' },
    });
  }

  // The plan's provider product and the agreed price's provider price,
  // created once and recorded with a set-once compare-and-set (the database
  // trigger refuses a change). The provider calls are deterministic, so
  // concurrent requests converge on the same objects.
  private async syncPrice(subscription: SubscriptionView): Promise<string> {
    const plan = subscription.planVersion.plan;
    const price = subscription.planPrice!;
    try {
      let externalProductId = plan.externalProductId;
      if (externalProductId === null) {
        ({ externalProductId } = await this.provider.ensureProduct({
          planId: plan.id,
          planName: plan.name,
        }));
        await this.prisma.subscriptionPlan.updateMany({
          where: { id: plan.id, externalProductId: null },
          data: { externalProductId },
        });
        externalProductId = (
          await this.prisma.subscriptionPlan.findUniqueOrThrow({
            where: { id: plan.id },
            select: { externalProductId: true },
          })
        ).externalProductId!;
      }
      if (price.externalPriceId !== null) return price.externalPriceId;
      const { externalPriceId } = await this.provider.ensurePrice({
        priceId: price.id,
        externalProductId,
        amountMinorUnits: price.amountMinorUnits,
        currency: price.currency,
        interval: price.interval,
      });
      await this.prisma.subscriptionPlanPrice.updateMany({
        where: { id: price.id, externalPriceId: null },
        data: { externalPriceId },
      });
      const stored = await this.prisma.subscriptionPlanPrice.findUniqueOrThrow({
        where: { id: price.id },
        select: { externalPriceId: true },
      });
      return stored.externalPriceId!;
    } catch (error) {
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }
  }

  // A trial is offered only when the policy has trials, this subscription
  // never had one, and the owner's email has not claimed one for another
  // business (no claim secret configured = no trial, never an unchecked one).
  private async offeredTrial(
    subscription: SubscriptionView,
    ownerEmail: string,
  ): Promise<{
    trialDays: number;
    requiresPaymentMethod: boolean;
    claimKey: string | null;
  }> {
    const policy = await this.prisma.billingPolicy.findUniqueOrThrow({
      where: { id: DEFAULT_BILLING_POLICY_ID },
    });
    const secret = process.env[TRIAL_CLAIM_SECRET_ENV];
    const none = { trialDays: 0, requiresPaymentMethod: true, claimKey: null };
    if (
      policy.trialDays === 0 ||
      subscription.trialStartedAt !== null ||
      typeof secret !== 'string' ||
      secret.length < 32
    ) {
      return none;
    }
    const claimKey = trialClaimKey(ownerEmail, secret);
    const existing = await this.prisma.billingTrialClaim.findUnique({
      where: { claimKey },
      select: { subscriptionId: true },
    });
    if (existing && existing.subscriptionId !== subscription.id) return none;
    const mine = await this.prisma.billingTrialClaim.findUnique({
      where: { subscriptionId: subscription.id },
      select: { claimKey: true },
    });
    if (mine && mine.claimKey !== claimKey) return none;
    // Another business of the same owner is in the middle of its trial
    // Checkout: asked to finish (or abandon) that first — never silently
    // offered no trial, never offered a second one.
    const elsewhere = await this.trialHeldElsewhere(claimKey, subscription.id);
    if (elsewhere === 'HELD') throw trialPendingElsewhere();
    if (elsewhere === 'USED') return none;
    return {
      trialDays: policy.trialDays,
      requiresPaymentMethod: policy.trialRequiresPaymentMethod,
      claimKey,
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as {
    code?: unknown;
    cause?: { originalCode?: unknown; code?: unknown };
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  return (
    e.code === 'P2002' ||
    e.cause?.originalCode === '23505' ||
    e.cause?.code === '23505' ||
    e.meta?.driverAdapterError?.cause?.originalCode === '23505'
  );
}
