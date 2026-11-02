import { timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CHECKOUT_ALREADY_COMPLETED,
  CHECKOUT_CHANGED_DURING_PAYMENT,
  CHECKOUT_SESSION_EXPIRED,
  CHECKOUT_SESSION_INVALID,
  CHECKOUT_NO_PAYMENT_IN_PROGRESS,
  CLIENT_PAYMENT_KEY_NOT_ACCEPTED,
  PAYMENT_SIMULATION_NOT_AVAILABLE,
  SIMULATED_PAYMENT_OUTCOMES,
  type CheckoutPaymentCheckRequest,
  type CheckoutPaymentRequiredResponse,
  type CheckoutPaymentSimulationRequest,
  type CheckoutPaymentState,
  type CheckoutSessionRequest,
  type CheckoutSessionResponse,
  type CheckoutSubmitResult,
} from '@mocha-house/contracts';
import type {
  CheckoutQuoteRequest,
  CheckoutQuoteResponse,
  CheckoutRequest,
  CheckoutRewardEligibilityRequest,
  CheckoutRewardEligibilityResponse,
  CheckoutRewardOption,
  OrderConfirmation,
  OrderStatusResponse,
} from '@mocha-house/contracts';
import { priceCart } from '@mocha-house/domain';
import {
  FakeTwoStepPaymentProvider,
  isPaymentIntentProvider,
  type PaymentAccountContext,
  type PaymentProvider,
} from '@mocha-house/integrations';
import {
  Prisma,
  productionSignal,
  type TenantContext,
} from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { requireTenantOwnership } from '../../tenancy/tenant-ownership';
import { LocationsService } from '../../locations/application/locations.service';
import { CustomersService } from '../../customers/application/customers.service';
import { LoyaltyService } from '../../loyalty/application/loyalty.service';
import {
  LoyaltyRedemptionService,
  type RedemptionPlan,
  type RegularDiscountContext,
} from '../../loyalty/application/loyalty-redemption.service';
import { LoyaltyBonusService } from '../../loyalty/application/loyalty-bonus.service';
import {
  PromotionCheckoutService,
  type RegularDiscountPlan,
  type RegularDiscountResolution,
} from '../../promotions/application/promotion-checkout.service';
import {
  featureNotAvailable,
  salesNotAvailable,
  StorefrontFeaturesService,
} from '../../subscriptions/application/storefront-features.service';
import {
  GiftCardRedemptionService,
  type GiftCardTenderPlan,
} from '../../gift-cards/application/gift-card-redemption.service';
import type { CustomerIdentity } from '../../customer-auth/infrastructure/customer-identity';
import { assertValidCheckoutLines } from './validate-checkout-lines';
import {
  CHECKOUT_SESSION_NEW_ATTEMPTS_MS,
  CHECKOUT_TOKEN_LIFETIME_MS,
  CHECKOUT_TOKEN_PATTERN,
  checkoutFingerprint,
  generateCheckoutToken,
  generatePaymentKey,
  hashCheckoutToken,
} from './checkout-session';
import {
  buildCheckoutSnapshot,
  giftCardPlanOf,
  FROZEN_CHECKOUT_SNAPSHOT_VERSION,
  FrozenCheckoutMismatchError,
  LEGACY_CHECKOUT_SNAPSHOT_VERSION,
  freezeCheckout,
  readSavedCheckout,
  verifyFrozenCheckout,
  type FrozenCheckout,
  type FrozenLine,
  type SavedCheckout,
  UnreadableCheckoutSnapshotError,
} from './checkout-snapshot';
import { PAYMENT_PROVIDER } from '../infrastructure/payment-provider.token';
import {
  chargeAttempt,
  customerPaymentMessage,
  heldStateOf,
  HELD_PAYMENT_MESSAGE,
  openReconciliationCase,
  resolveCaseAsFulfilled,
} from '../../payment/payment-charge';
import {
  consumeHoldsForOrder,
  prepareHoldsForOrder,
  reserveFinancialHolds,
  type HoldRequest,
} from '../../payment/financial-holds';
import {
  checkPaymentIntent,
  paymentAccountContext,
  startPaymentIntent,
} from '../../payment/payment-intent';
import {
  generateOrderAccessToken,
  generateOrderNumber,
} from '../infrastructure/order-identifiers';
import {
  toOrderGiftCardSummary,
  toOrderLineSummary,
  toOrderLoyaltyBonusSummary,
  toOrderLoyaltyRewardSummary,
  toOrderPromotionSummary,
} from '../infrastructure/order-line-mapper';

const MAX_ORDER_NUMBER_ATTEMPTS = 5;

// SC2b — what a business without the promotions module resolves to.
const NO_REGULAR_DISCOUNT: RegularDiscountResolution = { outcome: 'none' };

type OrderWithRelations = Prisma.OrderGetPayload<{
  include: {
    lines: true;
    location: true;
    promotionRedemption: true;
    loyaltyRewardRedemption: true;
    loyaltyBonus: { include: { items: true } };
    giftCardRedemption: true;
  };
}>;

const ORDER_INCLUDE = {
  lines: true,
  location: true,
  promotionRedemption: true,
  loyaltyRewardRedemption: true,
  loyaltyBonus: { include: { items: true } },
  giftCardRedemption: true,
} satisfies Prisma.OrderInclude;

type PaymentAttemptRow = Prisma.PaymentAttemptGetPayload<Record<string, never>>;
type CheckoutSessionRow = Prisma.CheckoutSessionGetPayload<
  Record<string, never>
>;

// ESP-03 PR 6 — refusals.
function invalidSession(): ConflictException {
  return new ConflictException({
    code: CHECKOUT_SESSION_INVALID,
    message:
      'This checkout is no longer valid. Refresh the page to start again. If you already paid, do not pay again — check your order or contact the restaurant.',
  });
}

function clientPaymentKeyRefused(): BadRequestException {
  return new BadRequestException({
    code: CLIENT_PAYMENT_KEY_NOT_ACCEPTED,
    message:
      'This checkout page is out of date. Refresh the page and place your order again — nothing was charged.',
  });
}

function sameFingerprint(stored: string | null, presented: string): boolean {
  if (stored === null || stored.length !== presented.length) return false;
  return timingSafeEqual(Buffer.from(stored), Buffer.from(presented));
}

// ESP-03 PR 4 — the payment behind an order must be definitively charged.
class PaymentNotConfirmedError extends ConflictException {
  constructor() {
    super('This payment has not been confirmed.');
  }
}

// An attempt saved but never sent to the provider after this long was
// abandoned by the request that created it (a provider call is bounded far
// below this).
const STRANDED_ATTEMPT_MS = 10 * 60 * 1000;

const FULFILMENT_RETRY_MESSAGE =
  'Your payment was received but your order could not be confirmed just ' +
  'now. Do not pay again — please try again in a moment.';

function manualReviewMessage(paymentAttemptId: string): string {
  return (
    `Your payment was processed but the order could not be completed ` +
    `automatically. This has been flagged for manual review — do not ` +
    `submit payment again. Reference ${paymentAttemptId} for support.`
  );
}

// Orchestrates the approved Milestone 3 first-transaction-slice sequence:
// validate idempotency -> reprice the authoritative cart -> durable
// payment-attempt record -> FakePaymentProvider -> (only on success) a
// protected transaction that creates the immutable Order + OrderLine
// snapshots, the initial OrderStatusHistory row, and the transactional
// OutboxEvent -> confirmation. Nothing here creates an Order ahead of a
// successful payment, and nothing here consumes the outbox — that is the
// Store Queue slice.
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locationsService: LocationsService,
    private readonly customersService: CustomersService,
    private readonly loyaltyService: LoyaltyService,
    private readonly redemptionService: LoyaltyRedemptionService,
    private readonly bonusService: LoyaltyBonusService,
    private readonly promotionService: PromotionCheckoutService,
    private readonly giftCardRedemptionService: GiftCardRedemptionService,
    @Inject(PAYMENT_PROVIDER)
    private readonly paymentProvider: PaymentProvider,
    private readonly storefrontFeatures: StorefrontFeaturesService,
  ) {}

  // customerIdentity is optional — sign-in is never required to check out
  // (see OrdersController's OptionalCustomerAuthGuard). When present, it
  // has already been verified by the customer-auth boundary; this method
  // never verifies a token itself.
  //
  // `tenant` is the request's server-resolved TenantContext. It
  // JIT-resolves the signed-in Customer (Milestone S0D-2B-1) and, since
  // Milestone S0D-2C-1, establishes who owns this checkout: the Location
  // must belong to it (checked before pricing, before any PaymentAttempt
  // exists and before any charge), the PaymentAttempt copies that
  // Location's tenant, and the Order, its lines, its first status-history
  // row and its outbox event copy the attempt's. ESP-03 PR 6 — a checkout
  // session is only ever used by its own business, location and customer.
  //
  // ESP-04 M2 — checkout() answers with the order (a one-step payment, a
  // zero-charge order, a completed checkout). submit() also answers a
  // two-step payment that waits for its customer (PAYMENT_REQUIRED).
  async checkout(
    request: CheckoutRequest,
    customerIdentity: CustomerIdentity | undefined,
    tenant: TenantContext,
  ): Promise<OrderConfirmation> {
    const result = await this.submit(request, customerIdentity, tenant);
    if (result.outcome !== 'COMPLETED') {
      throw new ConflictException(HELD_PAYMENT_MESSAGE);
    }
    return result.confirmation;
  }

  async submit(
    request: CheckoutRequest,
    customerIdentity: CustomerIdentity | undefined,
    tenant: TenantContext,
  ): Promise<CheckoutSubmitResult> {
    this.validateRequestShape(request);

    // Resolved once, up front, alongside the other pre-payment steps —
    // never re-derived inside the transaction or on replay, so a
    // subsequent status/history read of this Order always reflects
    // whichever Customer (if any) was authenticated at the moment payment
    // was attempted, not whatever happens to be true later.
    const customerId = await this.resolveCustomerId(customerIdentity, tenant);

    // Milestone S0D-2C-1 — the Location must belong to the request's
    // tenant. Another tenant's Location is reported exactly like a missing
    // or unorderable one (the same 404 findMenu gives below), so checkout
    // can never confirm it exists. This is the tenant the whole checkout
    // (PaymentAttempt, Order and its children) is written under.
    const tenantId = await this.requireLocationTenant(
      request.locationId,
      tenant,
    );

    // ESP-03 PR 6 — the server-owned checkout session this request belongs
    // to: this business, this location and this customer (or guest), or
    // nothing is revealed and nothing is charged. Every retry of this
    // checkout presents the same token. Checked after the request itself,
    // the customer and the location, so those answer exactly as before.
    if (
      typeof request.checkoutToken !== 'string' ||
      !CHECKOUT_TOKEN_PATTERN.test(request.checkoutToken)
    ) {
      throw invalidSession();
    }
    const session = await this.requireSession(
      request.checkoutToken,
      tenant,
      customerId,
    );
    if (session.locationId !== request.locationId) {
      throw invalidSession();
    }
    const rewardIdInput =
      typeof request.loyaltyRewardId === 'string' &&
      request.loyaltyRewardId.trim().length > 0
        ? request.loyaltyRewardId.trim()
        : null;
    const fingerprint = checkoutFingerprint(request.checkoutToken, {
      tenantId: session.tenantId,
      locationId: request.locationId,
      customerId,
      guest: request.guest,
      lines: request.lines,
      rewardId: rewardIdInput,
      couponCode: normalizeRequestCoupon(request.couponCode),
      giftCardCode: normalizeRequestGiftCardCode(request.giftCardCode),
    });

    // A payment for this checkout that may be charging, is held or unknown,
    // or succeeded answers every retry (the stored outcome, never a new
    // charge). Only after a definitively unsuccessful one may a new attempt
    // start — and only for a session still accepting new payments.
    const live = await this.liveAttemptOf(session);
    if (live) {
      return this.answerForLiveAttempt(live, fingerprint);
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException({
        code: CHECKOUT_SESSION_EXPIRED,
        message:
          'This checkout has expired. Refresh the page to start again — nothing was charged for it.',
      });
    }

    const menu = await this.locationsService.findMenu(
      request.locationId,
      tenantId,
    );
    if (!menu) {
      throw new NotFoundException('Location or menu not found.');
    }

    const priced = priceCart(menu, request.lines);
    if (!priced.ok) {
      throw new BadRequestException(priced.error.message);
    }

    // SC2b — the business's plan is evaluated ONCE, here, for this new
    // submission and before any payment attempt exists. A coupon or reward
    // the plan does not include is refused now (403, nothing charged). The
    // same decision is then carried into the post-payment order
    // transaction and never re-evaluated there, so a plan change while this
    // checkout is being paid can neither fail a paid order nor change what
    // was charged. A retry with the same idempotency key replays the stored
    // outcome and never re-runs any of this.
    // SC4b — a business still awaiting payment setup takes no orders.
    const { features, salesOpen } =
      await this.storefrontFeatures.forCheckout(tenantId);
    if (!salesOpen) throw salesNotAvailable();

    // Milestone 7E — resolve the ONE regular Promotion/Coupon FIRST. A
    // supplied coupon that fails any rule is rejected here, before any
    // payment attempt exists (never silently swapped for an automatic
    // Promotion). With no coupon, the best eligible automatic Promotion (if
    // any) applies.
    const couponCode = normalizeRequestCoupon(request.couponCode);
    if (couponCode !== null && !features.promotions) {
      throw featureNotAvailable('promotions');
    }
    // Without the promotions module no automatic Promotion applies either.
    const regularResolution: RegularDiscountResolution = features.promotions
      ? await this.promotionService.resolveRegularDiscount({
          tenantId,
          priced,
          menu,
          locationId: request.locationId,
          customerId,
          couponCode,
        })
      : NO_REGULAR_DISCOUNT;
    if (regularResolution.outcome === 'coupon_rejected') {
      throw new BadRequestException(regularResolution.message);
    }
    const regularPlan =
      regularResolution.outcome === 'applied' ? regularResolution.plan : null;
    const regularDiscount = regularPlan?.discountMinorUnits ?? 0;
    const merchandiseAfterRegular = priced.subtotal - regularDiscount;

    // Milestone 7C — resolve a chosen Mocha Bean reward, against the
    // merchandise remaining after the regular discount. A guest that submits
    // a reward id is rejected here, before any payment attempt exists —
    // never auto-matched to an account. All numbers below are
    // server-computed; the client only sent an id / code.
    const rewardId =
      typeof request.loyaltyRewardId === 'string' &&
      request.loyaltyRewardId.trim().length > 0
        ? request.loyaltyRewardId.trim()
        : null;
    let prePaymentPlan: RedemptionPlan | null = null;
    if (rewardId !== null && !features.loyalty) {
      throw featureNotAvailable('loyalty');
    }
    if (rewardId !== null) {
      if (customerId === null) {
        throw new BadRequestException('Sign in to use a Mocha Bean reward.');
      }
      prePaymentPlan = await this.redemptionService.buildRedemptionPlan(
        rewardId,
        priced,
        menu,
        tenantId,
        regularRewardContext(regularPlan, merchandiseAfterRegular),
      );
      // ESP-03 PR 8 — what is available: the balance minus the Beans held
      // by this customer's payments in progress (re-checked under lock when
      // the payment attempt is created).
      const balance = await this.loyaltyService.getAvailableBalanceForCustomer(
        customerId,
        tenantId,
      );
      if (balance < prePaymentPlan.beanCost) {
        throw new ConflictException(
          `You don't have enough Mocha Beans for this reward ` +
            `(need ${prePaymentPlan.beanCost}, have ${balance}).`,
        );
      }
    }

    // Gross merchandise minus the regular discount minus the reward
    // discount — the amount owed. Guaranteed >= 0 (each discount is capped
    // at the merchandise then remaining).
    const amountOwed =
      merchandiseAfterRegular - (prePaymentPlan?.discountMinorUnits ?? 0);

    // Milestone 7G — resolve the ONE gift card (if a code was supplied) and
    // size its tender against the amount owed, BEFORE any payment attempt
    // exists. An invalid / inactive / depleted / wrong-currency card is
    // rejected here (no charge, no order). The gift card is a TENDER — it
    // does NOT reduce the merchandise basis for promotion / Bean earning.
    // The planned tender is baked into PaymentAttempt.amount below and is
    // never silently reduced afterwards.
    const giftCardCode = normalizeRequestGiftCardCode(request.giftCardCode);
    let giftCardPlan: GiftCardTenderPlan | null = null;
    if (giftCardCode !== null) {
      giftCardPlan = await this.giftCardRedemptionService.buildTenderPlan(
        giftCardCode,
        amountOwed,
        priced.currency,
        tenantId,
      );
    }
    const giftCardTender = giftCardPlan?.plannedTenderMinorUnits ?? 0;

    // What is charged to the external payment method: the amount owed minus
    // whatever the gift card covers. Gift card applies BEFORE external
    // payment.
    const chargeAmount = amountOwed - giftCardTender;

    // Payment safety — an external charge is needed but no payment provider
    // can take it (none configured, or production with the simulated one):
    // refuse BEFORE recording a payment attempt, an order or a gift-card
    // redemption. A reward or gift card covering everything needs no
    // provider and continues.
    if (chargeAmount > 0 && !this.paymentProvider.acceptsPayments) {
      throw new ServiceUnavailableException(
        'Online payment is not available right now.',
      );
    }

    // ESP-03 PR 7 — the loyalty Beans this order earns (standard and
    // bonus), computed now from the frozen prices and discounts and applied
    // only when the order is created. Nothing for a guest, or when the plan
    // does not include loyalty.
    let loyalty: FrozenCheckout['loyalty'] = null;
    if (customerId !== null && features.loyalty) {
      const rewardDiscount = prePaymentPlan?.discountMinorUnits ?? 0;
      loyalty = {
        earnBeans: await this.loyaltyService.planEarning(
          this.prisma,
          tenantId,
          priced.subtotal - regularDiscount - rewardDiscount,
          priced.currency,
        ),
        bonus: await this.bonusService.planBonusForOrder(this.prisma, {
          tenantId,
          locationId: request.locationId,
          currency: priced.currency,
          pricedLines: priced.lines.map((line) => ({
            productId: line.productId,
            productName: line.productName,
            unitPrice: line.unitPrice,
            quantity: line.quantity,
          })),
          freeUnitLineIndices: freedUnitLineIndices(
            regularPlan,
            prePaymentPlan,
          ),
          orderLevelDiscounts: orderLevelDiscountBuckets(
            regularPlan,
            regularDiscount,
            prePaymentPlan,
            rewardDiscount,
          ),
        }),
      };
    }

    // ESP-03 PR 4 — the server-validated checkout, saved in the SAME
    // transaction as the payment attempt and committed BEFORE the provider
    // is called. If it cannot be saved, no attempt exists and nothing is
    // charged. The order is only ever created from this saved checkout.
    // ESP-03 PR 7 — frozen (version 2): the priced lines, discounts, reward,
    // loyalty earnings, gift-card tender and the amount charged; the order
    // is created from exactly this, never re-priced.
    const snapshot: SavedCheckout = {
      ...buildCheckoutSnapshot({
        locationId: request.locationId,
        lines: request.lines,
        guest: request.guest,
        customerId,
        rewardId,
        couponCode,
        giftCardPlan,
        features,
      }),
      frozen: freezeCheckout({
        currency: priced.currency,
        lines: priced.lines,
        subtotal: priced.subtotal,
        regularPlan,
        rewardPlan: prePaymentPlan,
        giftCardTender,
        charge: chargeAmount,
        loyalty,
      }),
    };
    const created = await this.createPaymentAttempt(
      session,
      fingerprint,
      request.locationId,
      chargeAmount,
      priced.currency,
      tenantId,
      snapshot,
      // ESP-03 PR 8 — reserved with the attempt, before any charge.
      holdRequestOf(
        customerId,
        features,
        regularPlan,
        prePaymentPlan,
        giftCardPlan,
      ),
    );

    if (!created.wasCreatedByThisRequest) {
      // A concurrent submission for this checkout created its live attempt
      // first — never charge twice for one checkout: answer with that
      // attempt (or refuse a different checkout) exactly like a retry.
      return this.answerForLiveAttempt(created.attempt, fingerprint);
    }

    const attempt = created.attempt;

    if (chargeAmount === 0) {
      // A reward and/or a gift card covered the entire amount owed — there
      // is nothing to charge externally. Skip the payment provider (a real
      // gateway rejects a $0 charge) and mark the attempt succeeded so the
      // rest of the order flow, and replay, are completely unchanged. A
      // full-gift-card order still records its REDEMPTION transactionally
      // in createOrderTransactionally below.
      // ESP-03 PR 6 — only from NOT_SENT (the same claim a charge needs), so
      // an attempt closed meanwhile is never turned into a success.
      const claimed = await this.prisma.paymentAttempt.updateMany({
        where: {
          id: attempt.id,
          tenantId: attempt.tenantId,
          status: 'PENDING',
          paymentState: 'NOT_SENT',
        },
        data: {
          status: 'SUCCEEDED',
          paymentState: 'SUCCEEDED',
          providerReference: 'no-charge',
        },
      });
      if (claimed.count !== 1) {
        const current = await this.prisma.paymentAttempt.findUniqueOrThrow({
          where: { id: attempt.id },
        });
        return this.completed(await this.replay(current));
      }
    } else if (isPaymentIntentProvider(this.paymentProvider)) {
      // ESP-04 M2 — two steps: the intent for the frozen amount is created
      // under the attempt's own key, for the restaurant account our records
      // name (never the request's), and the customer then confirms it.
      const account = await paymentAccountContext(this.prisma, tenantId);
      const started = await startPaymentIntent(
        this.prisma,
        this.paymentProvider,
        attempt,
        {
          amount: chargeAmount,
          currency: priced.currency,
          account,
          metadata: { paymentAttemptId: attempt.id },
        },
      );
      if (started.kind === 'customer-action') {
        return this.paymentRequired(
          { ...attempt, providerReference: started.reference },
          'REQUIRES_CUSTOMER_ACTION',
          account,
        );
      }
      if (started.kind === 'failed') {
        await this.discardSnapshot(attempt);
        throw new HttpException(
          { outcome: 'failed', message: customerPaymentMessage('failed') },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
      if (started.kind === 'held' || started.kind === 'not-claimed') {
        throw new ConflictException(HELD_PAYMENT_MESSAGE);
      }
    } else {
      // ESP-03 PR 2 — CHARGING is committed before the provider is called;
      // a throw / timeout / pending result is held (never FAILED, never
      // retried here); definitive outcomes are persisted conditionally.
      const charged = await chargeAttempt(
        this.prisma,
        this.paymentProvider,
        attempt,
        {
          amount: chargeAmount,
          currency: priced.currency,
          metadata: { guestPhone: request.guest.phone },
        },
      );

      if (charged.kind === 'declined' || charged.kind === 'failed') {
        // ESP-03 PR 4 — nothing will be fulfilled: the saved checkout goes.
        await this.discardSnapshot(attempt);
        // ESP-03 PR 3 — fixed wording; the provider's text stays internal.
        throw new HttpException(
          {
            outcome: charged.kind,
            message: customerPaymentMessage(charged.kind),
          },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
      if (charged.kind === 'held' || charged.kind === 'not-claimed') {
        throw new ConflictException(HELD_PAYMENT_MESSAGE);
      }
    }

    // ESP-03 PR 4 — the order is created from the saved checkout (the same
    // path any later recovery takes), never from this request directly.
    return this.completed(await this.fulfilFromSnapshot(attempt));
  }

  // ESP-03 PR 4 — recovery for a definitively charged payment whose order
  // does not exist yet (the first attempt crashed, failed to write, or was
  // interrupted). Finds the payment within the given business only, and
  // creates its order from the saved checkout exactly once. It NEVER calls
  // the payment provider. For server-side callers (a later recovery job or
  // support tool, ESP-03 PR 5); a customer retry with the same key reaches
  // the same path through replay().
  // ESP-03 PR 8 — food-order payments saved but never sent to the provider
  // long after they were created (the request stopped before charging):
  // each is closed as ABANDONED by the conditional update from NOT_SENT —
  // the state the charge claim also needs, so nothing can have been or will
  // be charged — and its financial holds are released in that same
  // transaction. Run by the recovery sweep, a bounded batch at a time.
  async abandonStrandedUnsentAttempts(
    now: Date = new Date(),
    limit = 50,
  ): Promise<number> {
    const stranded = await this.prisma.paymentAttempt.findMany({
      where: {
        status: 'PENDING',
        paymentState: 'NOT_SENT',
        checkoutSessionId: { not: null },
        createdAt: { lt: new Date(now.getTime() - STRANDED_ATTEMPT_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    let abandoned = 0;
    for (const attempt of stranded) {
      if (await this.abandonIfNeverSent(attempt)) abandoned += 1;
    }
    return abandoned;
  }

  async recoverFulfilment(
    paymentAttemptId: string,
    tenantId: string,
  ): Promise<OrderConfirmation> {
    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: { id: paymentAttemptId, tenantId },
    });
    if (
      !attempt ||
      attempt.status !== 'SUCCEEDED' ||
      attempt.paymentState !== 'SUCCEEDED'
    ) {
      // Unknown, another business's, or not definitively charged: an
      // uncertain payment is never treated as a success.
      throw new ConflictException('This payment cannot be fulfilled.');
    }
    return this.fulfilFromSnapshot(attempt);
  }

  // ESP-03 PR 4 — creates the order for a charged payment from its saved
  // checkout, exactly once. Every path locks the PaymentAttempt row first
  // and returns an order that already exists, so no retry, recovery or
  // concurrent request can create a second order or repeat a gift-card,
  // loyalty or promotion effect. On failure the payment stays SUCCEEDED,
  // is flagged for review with an open reconciliation case, and keeps its
  // saved checkout for a later recovery.
  private async fulfilFromSnapshot(
    attempt: PaymentAttemptRow,
  ): Promise<OrderConfirmation> {
    const tenantId = attempt.tenantId;
    const existing = await this.prisma.order.findUnique({
      where: { paymentAttemptId: attempt.id },
      include: ORDER_INCLUDE,
    });
    if (existing) {
      return this.toConfirmation(existing);
    }
    const saved = await this.prisma.checkoutSnapshot.findUnique({
      where: {
        tenantId_paymentAttemptId: { tenantId, paymentAttemptId: attempt.id },
      },
      select: { version: true, payload: true },
    });
    if (!saved) {
      // Fulfilled meanwhile (the saved checkout goes with its order).
      const order = await this.prisma.order.findUnique({
        where: { paymentAttemptId: attempt.id },
        include: ORDER_INCLUDE,
      });
      if (order) {
        return this.toConfirmation(order);
      }
      // ESP-03 PR 6 — a confirmed payment with neither its order nor its
      // saved checkout is flagged for people (with a reconciliation case),
      // never left silent.
      await this.recordFulfilmentFailure(
        attempt,
        new Error('The saved checkout for this payment is missing.'),
      );
      throw new ConflictException(manualReviewMessage(attempt.id));
    }

    let order: OrderWithRelations;
    try {
      const checkout = readSavedCheckout(saved.version, saved.payload);
      // Milestone 7A — prepare the customer's loyalty account (a unique-key
      // race is swallowed inside). Inside the failure handling below: a
      // failure here is handled exactly like an order-transaction failure.
      // SC2b — only when the plan included loyalty at submission.
      if (checkout.customerId !== null && checkout.features.loyalty) {
        await this.loyaltyService.ensureAccountForCustomer(checkout.customerId);
      }
      order = await this.createOrderTransactionally(attempt, checkout);
    } catch (error) {
      // The order transaction may have committed even though this request
      // saw an error (a lost commit acknowledgement): an existing order is
      // the answer, and nothing is flagged.
      const committed = await this.prisma.order
        .findUnique({
          where: { paymentAttemptId: attempt.id },
          include: ORDER_INCLUDE,
        })
        .catch(() => null);
      if (committed) {
        return this.toConfirmation(committed);
      }
      if (!(error instanceof PaymentNotConfirmedError)) {
        await this.recordFulfilmentFailure(attempt, error);
      }
      throw error;
    }
    return this.toConfirmation(order);
  }

  // The payment succeeded but its order could not be created: durably
  // flagged for review (never silently orphaned, never charged again, never
  // marked failed) with a reconciliation case. Best effort — if even this
  // cannot be written, it is logged with the payment's id.
  private async recordFulfilmentFailure(
    attempt: PaymentAttemptRow,
    error: unknown,
  ): Promise<void> {
    const reason =
      error instanceof Error
        ? error.message
        : 'Unknown error creating the order after a successful payment.';
    try {
      // Never flag a payment whose order exists.
      const order = await this.prisma.order.findUnique({
        where: { paymentAttemptId: attempt.id },
        select: { id: true },
      });
      if (order) {
        return;
      }
      await this.prisma.paymentAttempt.updateMany({
        where: { id: attempt.id, tenantId: attempt.tenantId },
        data: {
          reconciliationRequired: true,
          reconciliationReason: reason.slice(0, 500),
          reconciliationDetectedAt: new Date(),
          fulfilmentStatus: 'NEEDS_REVIEW',
        },
      });
    } catch (writeError) {
      this.logger.error(
        `payment attempt ${attempt.id}: its order could not be created and the failure could not be recorded (${
          writeError instanceof Error ? writeError.name : 'unknown error'
        })`,
      );
    }
    await openReconciliationCase(this.prisma, attempt.id, 'FULFILMENT_FAILED', {
      outcome: 'succeeded',
    });
  }

  // A definitively declined or failed payment needs no saved checkout.
  // Best effort: a leftover row is harmless (it can never become an order,
  // because its payment never succeeded).
  private async discardSnapshot(attempt: PaymentAttemptRow): Promise<void> {
    try {
      await this.prisma.checkoutSnapshot.deleteMany({
        where: { tenantId: attempt.tenantId, paymentAttemptId: attempt.id },
      });
      await this.prisma.paymentAttempt.updateMany({
        where: { id: attempt.id, tenantId: attempt.tenantId },
        data: { fulfilmentStatus: 'NOT_REQUIRED' },
      });
    } catch (error) {
      this.logger.warn(
        `payment attempt ${attempt.id}: the saved checkout could not be removed (${
          error instanceof Error ? error.name : 'unknown error'
        })`,
      );
    }
  }

  // Milestone 7C — the read-only checkout reward quote. Signed-in customers
  // only (the controller applies CustomerAuthGuard). Given the current cart
  // it returns the ACTIVE rewards eligible for THAT cart, with the discount
  // each would apply and whether the customer can afford it. Mutates
  // nothing, reserves nothing, deducts nothing. The checkout submission
  // independently revalidates everything under a row lock.
  async quoteRewardEligibility(
    request: CheckoutRewardEligibilityRequest,
    customerIdentity: CustomerIdentity,
    tenant: TenantContext,
  ): Promise<CheckoutRewardEligibilityResponse> {
    if (
      typeof request?.locationId !== 'string' ||
      request.locationId.trim().length === 0
    ) {
      throw new BadRequestException('locationId is required.');
    }
    if (!Array.isArray(request?.lines) || request.lines.length === 0) {
      throw new BadRequestException('Cart is empty.');
    }
    assertValidCheckoutLines(request.lines);

    const customer = await this.customersService.requireCustomer(
      customerIdentity,
      tenant,
      'write',
    );

    // The quote is priced only against the storefront business's own
    // Location, promotions, rewards and gift cards — exactly as checkout.
    const tenantId = await this.requireLocationTenant(
      request.locationId,
      tenant,
    );
    const menu = await this.locationsService.findMenu(
      request.locationId,
      tenantId,
    );
    if (!menu) {
      throw new NotFoundException('Location or menu not found.');
    }
    const priced = priceCart(menu, request.lines);
    if (!priced.ok) {
      throw new BadRequestException(priced.error.message);
    }

    // SC2b — without the loyalty module no reward is offered; the balance
    // is still the customer's and is reported unchanged.
    if (!(await this.storefrontFeatures.isAvailable(tenantId, 'loyalty'))) {
      const balance = await this.loyaltyService.getBalanceForCustomer(
        customer.id,
      );
      return { balance, rewards: [], available: false };
    }

    const preview = await this.redemptionService.previewForCart(
      customer.id,
      priced,
      menu,
      tenantId,
    );
    return { ...preview, available: true };
  }

  // Milestone 7E — the unified, server-authoritative checkout pricing quote.
  // Guests allowed (OptionalCustomerAuthGuard on the route). Given the cart,
  // an optional coupon code and an optional selected reward id, it returns
  // the regular Promotion/Coupon discount, the eligible Mocha Bean rewards
  // (signed-in only, computed against the post-regular merchandise) and the
  // resulting total. Reserves nothing, consumes no redemption, deducts no
  // Beans. The checkout submission independently revalidates everything.
  async quoteCheckout(
    request: CheckoutQuoteRequest,
    customerIdentity: CustomerIdentity | undefined,
    tenant: TenantContext,
  ): Promise<CheckoutQuoteResponse> {
    if (
      typeof request?.locationId !== 'string' ||
      request.locationId.trim().length === 0
    ) {
      throw new BadRequestException('locationId is required.');
    }
    if (!Array.isArray(request?.lines) || request.lines.length === 0) {
      throw new BadRequestException('Cart is empty.');
    }
    assertValidCheckoutLines(request.lines);

    const customerId = await this.resolveCustomerId(customerIdentity, tenant);

    // The quote is priced only against the storefront business's own
    // Location, promotions, rewards and gift cards — exactly as checkout.
    const tenantId = await this.requireLocationTenant(
      request.locationId,
      tenant,
    );
    const menu = await this.locationsService.findMenu(
      request.locationId,
      tenantId,
    );
    if (!menu) {
      throw new NotFoundException('Location or menu not found.');
    }
    const priced = priceCart(menu, request.lines);
    if (!priced.ok) {
      throw new BadRequestException(priced.error.message);
    }

    // SC2b — a quote reflects the plan right now but locks nothing: the
    // submission evaluates it again before payment.
    const features = await this.storefrontFeatures.forTenant(tenantId);

    const couponCode = normalizeRequestCoupon(request.couponCode);
    const resolution: RegularDiscountResolution = !features.promotions
      ? couponCode !== null
        ? {
            outcome: 'coupon_rejected',
            status: 'not_available',
            message: 'Promotions and coupons are not available here right now.',
          }
        : NO_REGULAR_DISCOUNT
      : await this.promotionService.resolveRegularDiscount({
          tenantId,
          priced,
          menu,
          locationId: request.locationId,
          customerId,
          couponCode,
        });

    let regularDiscountView: CheckoutQuoteResponse['regularDiscount'] = null;
    let couponStatus: CheckoutQuoteResponse['couponStatus'] = null;
    let couponMessage: string | null = null;
    let regularPlan: RegularDiscountPlan | null = null;

    if (resolution.outcome === 'coupon_rejected') {
      couponStatus = resolution.status;
      couponMessage = resolution.message;
    } else if (resolution.outcome === 'applied') {
      regularPlan = resolution.plan;
      regularDiscountView = {
        source: resolution.plan.kind,
        name: resolution.plan.name,
        discountType: resolution.plan.discountType,
        discountMinorUnits: resolution.plan.discountMinorUnits,
        freeItemName: resolution.plan.freeItem?.productName ?? null,
      };
      if (couponCode !== null) {
        couponStatus = 'applied';
      }
    }

    const regularDiscount = regularPlan?.discountMinorUnits ?? 0;
    const merchandiseAfterRegular = priced.subtotal - regularDiscount;

    let balance = 0;
    let rewards: CheckoutRewardOption[] = [];
    if (customerId !== null && !features.loyalty) {
      // The balance is kept and shown; no reward is offered.
      balance = await this.loyaltyService.getBalanceForCustomer(customerId);
    } else if (customerId !== null) {
      const preview = await this.redemptionService.previewForCart(
        customerId,
        priced,
        menu,
        tenantId,
        regularRewardContext(regularPlan, merchandiseAfterRegular),
      );
      balance = preview.balance;
      rewards = preview.rewards;
    }

    // The discount the currently-selected reward would apply.
    const selectedRewardId =
      typeof request.loyaltyRewardId === 'string' &&
      request.loyaltyRewardId.trim().length > 0
        ? request.loyaltyRewardId.trim()
        : null;
    let rewardDiscountMinorUnits = 0;
    if (selectedRewardId !== null && customerId !== null && features.loyalty) {
      try {
        const plan = await this.redemptionService.buildRedemptionPlan(
          selectedRewardId,
          priced,
          menu,
          tenantId,
          regularRewardContext(regularPlan, merchandiseAfterRegular),
        );
        rewardDiscountMinorUnits = plan.discountMinorUnits;
      } catch {
        // The selected reward no longer applies with the current cart /
        // regular discount — the quote just shows 0 for it.
        rewardDiscountMinorUnits = 0;
      }
    }

    const total = merchandiseAfterRegular - rewardDiscountMinorUnits;

    // Milestone 7G — READ-ONLY gift-card preview. Resolve the supplied code
    // against the current card state and report how much it WOULD apply
    // against the amount owed. No lock, no reservation, no decrement — the
    // checkout submission independently revalidates everything under a row
    // lock.
    const giftCardCode = normalizeRequestGiftCardCode(request.giftCardCode);
    let giftCardStatus: CheckoutQuoteResponse['giftCardStatus'] = null;
    let giftCardMessage: string | null = null;
    let giftCard: CheckoutQuoteResponse['giftCard'] = null;
    if (giftCardCode !== null) {
      const gc = await this.giftCardRedemptionService.resolveUsableCard(
        giftCardCode,
        priced.currency,
        tenantId,
      );
      if (gc.outcome === 'usable') {
        const applied = Math.max(0, Math.min(gc.balanceMinorUnits, total));
        if (applied === 0) {
          giftCardStatus = 'no_balance';
          giftCardMessage =
            "Your order total is already covered — you don't need a gift card.";
        } else {
          giftCardStatus = 'applied';
          giftCard = {
            last4: gc.last4,
            availableBalanceMinorUnits: gc.balanceMinorUnits,
            appliedMinorUnits: applied,
          };
        }
      } else {
        giftCardStatus = gc.outcome;
        giftCardMessage = GIFT_CARD_QUOTE_MESSAGE[gc.outcome];
      }
    }
    const giftCardApplied = giftCard?.appliedMinorUnits ?? 0;

    return {
      currency: priced.currency,
      subtotal: priced.subtotal,
      regularDiscount: regularDiscountView,
      couponStatus,
      couponMessage,
      balance,
      rewards,
      rewardDiscountMinorUnits,
      total,
      giftCardStatus,
      giftCardMessage,
      giftCard,
      amountDueAfterGiftCardMinorUnits: total - giftCardApplied,
      loyaltyAvailable: features.loyalty,
      promotionsAvailable: features.promotions,
    };
  }

  async getStatus(
    orderId: string,
    accessToken: string,
    tenant: TenantContext,
  ): Promise<OrderStatusResponse> {
    // Security 4B — the storefront only ever reveals its OWN business's
    // orders: another business's order, even with its valid accessToken,
    // reads exactly like an unknown id.
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: tenant.tenantId },
      include: { ...ORDER_INCLUDE, paymentAttempt: true },
    });

    if (!order || !constantTimeEquals(order.accessToken, accessToken)) {
      // Same response whether the id is unknown or the token is wrong —
      // the internal id is not authorization, so neither case should leak
      // which part was invalid.
      throw new NotFoundException('Order not found.');
    }

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentAttempt.status,
      locationName: order.location.name,
      guestName: order.guestName,
      subtotal: order.subtotal,
      promotionDiscount: order.promotionDiscountMinorUnits,
      rewardDiscount: order.rewardDiscountMinorUnits,
      total:
        order.subtotal -
        order.promotionDiscountMinorUnits -
        order.rewardDiscountMinorUnits,
      giftCardTenderMinorUnits: order.giftCardTenderMinorUnits,
      externalPaymentMinorUnits:
        order.subtotal -
        order.promotionDiscountMinorUnits -
        order.rewardDiscountMinorUnits -
        order.giftCardTenderMinorUnits,
      currency: order.currency,
      lines: order.lines.map(toOrderLineSummary),
      orderPromotion: toOrderPromotionSummary(order.promotionRedemption),
      loyaltyReward: toOrderLoyaltyRewardSummary(order.loyaltyRewardRedemption),
      loyaltyBonus: toOrderLoyaltyBonusSummary(order.loyaltyBonus),
      orderGiftCard: toOrderGiftCardSummary(order.giftCardRedemption),
      createdAt: order.createdAt.toISOString(),
    };
  }

  // customerIdentity is undefined ONLY for guest checkout (no Authorization
  // header): OptionalCustomerAuthGuard refuses a header that is present but
  // cannot be verified (401), so an expired or forged session never becomes
  // a guest order. SC4f-2: a signed-in checkout needs this business's own
  // ACTIVE profile (requireCustomer 'write') — never created here, and a
  // restricted, deactivated or not-joined login is refused, not downgraded.
  // The tenant of the ordering Location, which must belong to the request's
  // server-resolved tenant. Another tenant's Location is reported exactly
  // like a missing or unorderable one (the same 404 findMenu gives), so
  // checkout and its quotes can never confirm it exists. This is the tenant
  // every price, discount, reward and gift card is resolved under.
  private async requireLocationTenant(
    locationId: string,
    tenant: TenantContext,
  ): Promise<string> {
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { tenantId: true },
    });
    return requireTenantOwnership(
      location,
      tenant,
      'Location or menu not found.',
    );
  }

  private async resolveCustomerId(
    customerIdentity: CustomerIdentity | undefined,
    tenant: TenantContext,
  ): Promise<string | null> {
    if (!customerIdentity) {
      return null;
    }
    const customer = await this.customersService.requireCustomer(
      customerIdentity,
      tenant,
      'write',
    );
    return customer.id;
  }

  private validateRequestShape(request: CheckoutRequest): void {
    // ESP-03 PR 6 — payment keys are generated by the server only. A client
    // that still sends one (an out-of-date checkout page) is refused before
    // anything happens.
    if (
      request &&
      typeof request === 'object' &&
      Object.prototype.hasOwnProperty.call(request, 'idempotencyKey')
    ) {
      throw clientPaymentKeyRefused();
    }
    if (
      typeof request.locationId !== 'string' ||
      request.locationId.trim().length === 0
    ) {
      throw new BadRequestException('locationId is required.');
    }
    if (
      !request.guest ||
      typeof request.guest.name !== 'string' ||
      request.guest.name.trim().length === 0
    ) {
      throw new BadRequestException('Guest name is required.');
    }
    if (
      typeof request.guest.phone !== 'string' ||
      request.guest.phone.trim().length === 0
    ) {
      throw new BadRequestException('Guest phone is required.');
    }
    if (
      request.guest.email !== undefined &&
      request.guest.email !== null &&
      request.guest.email !== '' &&
      (typeof request.guest.email !== 'string' ||
        !request.guest.email.includes('@'))
    ) {
      throw new BadRequestException(
        'Guest email must be a valid email address.',
      );
    }
    if (!Array.isArray(request.lines) || request.lines.length === 0) {
      throw new BadRequestException('Cart is empty.');
    }
    assertValidCheckoutLines(request.lines);
    if (
      request.loyaltyRewardId !== undefined &&
      request.loyaltyRewardId !== null &&
      (typeof request.loyaltyRewardId !== 'string' ||
        request.loyaltyRewardId.trim().length === 0)
    ) {
      throw new BadRequestException(
        'loyaltyRewardId must be a reward id or null.',
      );
    }
    if (
      request.couponCode !== undefined &&
      request.couponCode !== null &&
      typeof request.couponCode !== 'string'
    ) {
      throw new BadRequestException('couponCode must be a string or null.');
    }
    if (
      request.giftCardCode !== undefined &&
      request.giftCardCode !== null &&
      typeof request.giftCardCode !== 'string'
    ) {
      throw new BadRequestException('giftCardCode must be a string or null.');
    }
  }

  // ESP-03 PR 6 — start, or resume, the checkout session a food-order
  // payment and its retries are bound to. A token that is still recognised
  // for this business, location and customer is kept: its held or completed
  // payment is reported (never charged again), and a session still accepting
  // payments is reused. Otherwise a new session starts. Never charges.
  async startSession(
    request: CheckoutSessionRequest,
    customerIdentity: CustomerIdentity | undefined,
    tenant: TenantContext,
  ): Promise<CheckoutSessionResponse> {
    if (
      !request ||
      typeof request.locationId !== 'string' ||
      request.locationId.trim().length === 0
    ) {
      throw new BadRequestException('locationId is required.');
    }
    if (Object.prototype.hasOwnProperty.call(request, 'idempotencyKey')) {
      throw clientPaymentKeyRefused();
    }
    const customerId = await this.resolveCustomerId(customerIdentity, tenant);
    const tenantId = await this.requireLocationTenant(
      request.locationId,
      tenant,
    );
    const presented =
      typeof request.checkoutToken === 'string' &&
      CHECKOUT_TOKEN_PATTERN.test(request.checkoutToken)
        ? request.checkoutToken
        : null;
    if (presented) {
      const existing = await this.findSession(presented, tenant, customerId);
      if (existing && existing.locationId === request.locationId) {
        const live = await this.liveAttemptOf(existing);
        if (live) {
          const order =
            live.status === 'SUCCEEDED'
              ? await this.prisma.order.findFirst({
                  where: { paymentAttemptId: live.id, tenantId },
                  include: ORDER_INCLUDE,
                })
              : null;
          return {
            checkoutToken: presented,
            state: order
              ? 'COMPLETED'
              : this.isTwoStepWaiting(live)
                ? 'PAYMENT_REQUIRED'
                : 'IN_PROGRESS',
            acceptsNewPaymentsUntil: existing.expiresAt.toISOString(),
            confirmation: order ? this.toConfirmation(order) : null,
          };
        }
        if (existing.expiresAt.getTime() > Date.now()) {
          return {
            checkoutToken: presented,
            state: 'OPEN',
            acceptsNewPaymentsUntil: existing.expiresAt.toISOString(),
            confirmation: null,
          };
        }
      }
    }
    await this.purgeUnusedSessions();
    const checkoutToken = generateCheckoutToken();
    const now = Date.now();
    const created = await this.prisma.checkoutSession.create({
      data: {
        tenantId,
        locationId: request.locationId,
        customerId,
        customerBound: customerId !== null,
        tokenHash: hashCheckoutToken(checkoutToken),
        createdAt: new Date(now),
        expiresAt: new Date(now + CHECKOUT_SESSION_NEW_ATTEMPTS_MS),
        tokenExpiresAt: new Date(now + CHECKOUT_TOKEN_LIFETIME_MS),
      },
      select: { expiresAt: true },
    });
    return {
      checkoutToken,
      state: 'OPEN',
      acceptsNewPaymentsUntil: created.expiresAt.toISOString(),
      confirmation: null,
    };
  }

  // The session a token names, only when it belongs to this business and
  // this customer (or guest) and is still recognised; otherwise null.
  private async findSession(
    checkoutToken: string,
    tenant: TenantContext,
    customerId: string | null,
  ): Promise<CheckoutSessionRow | null> {
    const session = await this.prisma.checkoutSession.findUnique({
      where: { tokenHash: hashCheckoutToken(checkoutToken) },
    });
    if (
      !session ||
      session.tenantId !== tenant.tenantId ||
      session.customerId !== customerId ||
      // A customer's session whose customer was removed is never a guest's.
      (session.customerBound && session.customerId === null) ||
      session.tokenExpiresAt.getTime() <= Date.now()
    ) {
      return null;
    }
    return session;
  }

  // Bounded housekeeping, best effort: sessions no longer recognised (past
  // their token lifetime) that never had a payment attempt hold no payment
  // record and are removed, a small batch at a time. A session with any
  // payment attempt is always kept.
  private async purgeUnusedSessions(): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        DELETE FROM "CheckoutSession" WHERE id IN (
          SELECT s.id FROM "CheckoutSession" s
          WHERE s."tokenExpiresAt" < now()
            AND NOT EXISTS (
              SELECT 1 FROM "PaymentAttempt" a
              WHERE a."checkoutSessionId" = s.id AND a."tenantId" = s."tenantId"
            )
          LIMIT 50
        )`;
    } catch (error) {
      this.logger.warn(
        `checkout session housekeeping failed (${
          error instanceof Error ? error.name : 'unknown error'
        })`,
      );
    }
  }

  // Another business's, another customer's, an expired or an unknown
  // session: one generic refusal that says nothing about which.
  private async requireSession(
    checkoutToken: string,
    tenant: TenantContext,
    customerId: string | null,
  ): Promise<CheckoutSessionRow> {
    const session = await this.findSession(checkoutToken, tenant, customerId);
    if (!session) throw invalidSession();
    return session;
  }

  // The session's live attempt: one that is not definitively unsuccessful
  // (the database allows at most one). An attempt saved but never sent to
  // the provider long after it was created is abandoned first — by a
  // conditional update from NOT_SENT, which the charge claim also needs, so
  // it can never race a real charge — and no longer counts.
  private async liveAttemptOf(
    session: CheckoutSessionRow,
  ): Promise<PaymentAttemptRow | null> {
    const live = await this.prisma.paymentAttempt.findFirst({
      where: {
        tenantId: session.tenantId,
        checkoutSessionId: session.id,
        status: { notIn: ['DECLINED', 'FAILED'] },
      },
    });
    if (
      live &&
      live.status === 'PENDING' &&
      live.paymentState === 'NOT_SENT' &&
      Date.now() - live.createdAt.getTime() > STRANDED_ATTEMPT_MS
    ) {
      if (await this.abandonIfNeverSent(live)) return null;
      // Changed meanwhile: claimed (live after all), or closed by a
      // concurrent request (then it no longer counts).
      const current = await this.prisma.paymentAttempt.findUnique({
        where: { id: live.id },
      });
      return current &&
        current.status !== 'DECLINED' &&
        current.status !== 'FAILED'
        ? current
        : null;
    }
    // A charge claimed long ago that never recorded an outcome (the process
    // stopped between the claim and the provider call, or the claim's
    // acknowledgement was lost): it may or may not have been charged, so it
    // is never abandoned — it is made visible to people instead.
    if (
      live &&
      live.status === 'PENDING' &&
      live.paymentState === 'CHARGING' &&
      Date.now() - live.updatedAt.getTime() > STRANDED_ATTEMPT_MS
    ) {
      await openReconciliationCase(this.prisma, live.id, 'CHARGE_STRANDED', {
        outcome: 'unknown',
      });
    }
    return live;
  }

  // Closes an attempt that was never sent to the payment provider — by a
  // conditional update from NOT_SENT, the same state the charge claim needs,
  // so it can never race a real charge — and only then removes its saved
  // checkout. False when the attempt was claimed or closed meanwhile.
  private async abandonIfNeverSent(
    attempt: PaymentAttemptRow,
  ): Promise<boolean> {
    // ESP-03 PR 8 — the database releases its financial holds in this same
    // statement (it was never sent, so nothing can have been charged).
    const abandoned = await this.prisma.paymentAttempt.updateMany({
      where: {
        id: attempt.id,
        tenantId: attempt.tenantId,
        status: 'PENDING',
        paymentState: 'NOT_SENT',
      },
      data: {
        status: 'FAILED',
        paymentState: 'ABANDONED',
        failureReason: 'Abandoned before it was sent to the payment provider.',
      },
    });
    if (abandoned.count !== 1) return false;
    await this.discardSnapshot(attempt);
    return true;
  }

  // A retry of this checkout while its payment is live: the same checkout is
  // answered with that payment's stored outcome (never charged again); a
  // changed checkout is refused — it never updates the saved order and never
  // receives a different order.
  private async answerForLiveAttempt(
    live: PaymentAttemptRow,
    fingerprint: string,
  ): Promise<CheckoutSubmitResult> {
    if (!sameFingerprint(live.requestFingerprint, fingerprint)) {
      const order =
        live.status === 'SUCCEEDED'
          ? await this.prisma.order.findFirst({
              where: { paymentAttemptId: live.id, tenantId: live.tenantId },
              select: { id: true },
            })
          : null;
      if (order) {
        throw new ConflictException({
          code: CHECKOUT_ALREADY_COMPLETED,
          message:
            'This checkout has already been paid for and its order placed. Your changes were not applied and nothing new was charged. To order again, start a new order.',
        });
      }
      throw new ConflictException({
        code: CHECKOUT_CHANGED_DURING_PAYMENT,
        message:
          'A payment for the earlier version of this order is still being processed. Your changes were not applied and nothing new was charged. Do not pay again.',
      });
    }
    return this.resume(live);
  }

  // ESP-04 M2 — POST /orders/checkout-sessions/payment: what happened to this
  // checkout's two-step payment, read from the payment provider (never from
  // the browser). The request names only the session: the payment, its
  // amount and the restaurant's account all come from our records.
  //   200 order       — paid (the order is created exactly once);
  //   202 waiting     — the customer still has to confirm, may try again on
  //                     the same payment, or the provider is processing it;
  //   402             — it definitively did not go through (holds released);
  //   409             — the outcome is not known yet (nothing changes).
  async checkPayment(
    request: CheckoutPaymentCheckRequest,
    customerIdentity: CustomerIdentity | undefined,
    tenant: TenantContext,
  ): Promise<CheckoutSubmitResult> {
    const session = await this.sessionForPayment(
      request,
      customerIdentity,
      tenant,
    );
    const live = await this.liveAttemptOf(session);
    if (live) {
      return this.resume(live);
    }
    // No live payment: the latest one's definitive outcome, if any.
    const latest = await this.prisma.paymentAttempt.findFirst({
      where: { tenantId: session.tenantId, checkoutSessionId: session.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest) {
      throw new ConflictException({
        code: CHECKOUT_NO_PAYMENT_IN_PROGRESS,
        message:
          'There is no payment in progress for this checkout. Nothing was charged.',
      });
    }
    return this.completed(await this.replay(latest));
  }

  // ESP-04 M2 — DEVELOPMENT AND TESTS ONLY: plays the customer's part with the
  // two-step fake provider (what the payment page would do with a real one).
  // Refused unless the fake is configured and no production-like signal is
  // present; it only ever names this checkout's own waiting payment, and it
  // never records anything itself — the outcome is still read back from the
  // provider by checkPayment.
  async simulatePayment(
    request: CheckoutPaymentSimulationRequest,
    customerIdentity: CustomerIdentity | undefined,
    tenant: TenantContext,
  ): Promise<void> {
    const provider = this.paymentProvider;
    if (
      !(provider instanceof FakeTwoStepPaymentProvider) ||
      productionSignal(process.env) !== null
    ) {
      throw new NotFoundException({
        code: PAYMENT_SIMULATION_NOT_AVAILABLE,
        message: 'The payment simulator is not available.',
      });
    }
    if (
      typeof request?.outcome !== 'string' ||
      !(SIMULATED_PAYMENT_OUTCOMES as readonly string[]).includes(
        request.outcome,
      )
    ) {
      throw new BadRequestException('outcome is not a supported value.');
    }
    const session = await this.sessionForPayment(
      request,
      customerIdentity,
      tenant,
    );
    const live = await this.liveAttemptOf(session);
    if (
      !live ||
      !this.isTwoStepWaiting(live) ||
      live.providerReference === null ||
      !provider.simulate(live.providerReference, live.tenantId, request.outcome)
    ) {
      throw new ConflictException({
        code: CHECKOUT_NO_PAYMENT_IN_PROGRESS,
        message: 'No payment of this checkout is waiting for its customer.',
      });
    }
  }

  // The checkout session a payment request names: this business, this
  // location and this customer (or guest), or one generic refusal.
  private async sessionForPayment(
    request: { locationId?: unknown; checkoutToken?: unknown },
    customerIdentity: CustomerIdentity | undefined,
    tenant: TenantContext,
  ): Promise<CheckoutSessionRow> {
    if (
      !request ||
      typeof request.locationId !== 'string' ||
      request.locationId.trim().length === 0
    ) {
      throw new BadRequestException('locationId is required.');
    }
    const customerId = await this.resolveCustomerId(customerIdentity, tenant);
    await this.requireLocationTenant(request.locationId, tenant);
    if (
      typeof request.checkoutToken !== 'string' ||
      !CHECKOUT_TOKEN_PATTERN.test(request.checkoutToken)
    ) {
      throw invalidSession();
    }
    const session = await this.requireSession(
      request.checkoutToken,
      tenant,
      customerId,
    );
    if (session.locationId !== request.locationId) {
      throw invalidSession();
    }
    return session;
  }

  // ESP-04 M2 — a live payment answered again (a retry, a reload, a check):
  // one waiting for its customer (or one this provider is processing) is
  // checked with the provider and resumed — the SAME intent, never a new
  // one; anything else is replayed as before.
  private async resume(
    attempt: PaymentAttemptRow,
  ): Promise<CheckoutSubmitResult> {
    if (this.isTwoStepWaiting(attempt)) {
      return this.checkWaitingPayment(attempt);
    }
    return this.completed(await this.replay(attempt));
  }

  // A two-step payment whose outcome only the provider can settle: waiting
  // for its customer, or (with this same two-step provider) processing.
  private isTwoStepWaiting(attempt: PaymentAttemptRow): boolean {
    if (attempt.status !== 'PENDING' || attempt.providerReference === null) {
      return false;
    }
    if (attempt.paymentState === 'REQUIRES_CUSTOMER_ACTION') return true;
    return (
      attempt.paymentState === 'AWAITING_CONFIRMATION' &&
      isPaymentIntentProvider(this.paymentProvider) &&
      attempt.provider === this.paymentProvider.name
    );
  }

  private async checkWaitingPayment(
    attempt: PaymentAttemptRow,
  ): Promise<CheckoutSubmitResult> {
    const provider = this.paymentProvider;
    if (
      !isPaymentIntentProvider(provider) ||
      attempt.providerReference === null
    ) {
      // Configured without two-step payments meanwhile: the outcome cannot be
      // read here, so nothing changes and the customer must not pay again.
      throw new ConflictException(HELD_PAYMENT_MESSAGE);
    }
    const account = await paymentAccountContext(this.prisma, attempt.tenantId);
    const checked = await checkPaymentIntent(
      this.prisma,
      provider,
      {
        id: attempt.id,
        tenantId: attempt.tenantId,
        providerReference: attempt.providerReference,
        paymentState: attempt.paymentState,
        amount: attempt.amount,
        currency: attempt.currency,
      },
      account,
    );
    switch (checked.kind) {
      case 'customer-action':
        return this.paymentRequired(attempt, checked.state, account);
      case 'processing':
        return this.paymentRequired(attempt, 'PROCESSING', account);
      case 'unknown':
        // Not definitive: the payment, its holds and its saved checkout stay.
        throw new ConflictException(HELD_PAYMENT_MESSAGE);
      case 'failed':
        // Cancelled at the provider: no charge can occur, the database has
        // released the holds, and nothing will be fulfilled.
        await this.discardSnapshot(attempt);
        throw new HttpException(
          { outcome: 'failed', message: customerPaymentMessage('failed') },
          HttpStatus.PAYMENT_REQUIRED,
        );
      case 'succeeded':
      case 'not-waiting': {
        // Paid (by this request or a concurrent one), or settled meanwhile:
        // the attempt as it now stands decides — the order exactly once.
        const current = await this.prisma.paymentAttempt.findFirstOrThrow({
          where: { id: attempt.id, tenantId: attempt.tenantId },
        });
        if (current.status === 'PENDING') {
          throw new ConflictException(HELD_PAYMENT_MESSAGE);
        }
        if (current.status === 'FAILED' || current.status === 'DECLINED') {
          await this.discardSnapshot(current);
        }
        return this.completed(await this.replay(current));
      }
    }
  }

  // The 202 answer: what the customer still has to do. The client secret is
  // fetched from the provider for this answer only — never stored or logged —
  // and never while the provider is processing (nothing to pay again).
  private async paymentRequired(
    attempt: PaymentAttemptRow,
    state: CheckoutPaymentState,
    account: PaymentAccountContext,
  ): Promise<CheckoutPaymentRequiredResponse> {
    const provider = this.paymentProvider;
    if (
      !isPaymentIntentProvider(provider) ||
      attempt.providerReference === null
    ) {
      throw new ConflictException(HELD_PAYMENT_MESSAGE);
    }
    let clientSecret: string | null = null;
    try {
      if (state !== 'PROCESSING') {
        clientSecret = await provider.clientSecretFor({
          reference: attempt.providerReference,
          account,
        });
      }
    } catch {
      throw new ServiceUnavailableException(
        'The payment page could not be loaded just now. Nothing new was charged — please try again in a moment.',
      );
    }
    return {
      outcome: 'PAYMENT_REQUIRED',
      payment: {
        provider: provider.name,
        state,
        clientSecret,
        amountMinorUnits: attempt.amount,
        currency: attempt.currency,
      },
    };
  }

  private completed(confirmation: OrderConfirmation): CheckoutSubmitResult {
    return { outcome: 'COMPLETED', confirmation };
  }

  private async replay(attempt: PaymentAttemptRow): Promise<OrderConfirmation> {
    // ESP-03 PR 2 — a charge whose outcome is not final is held: the client
    // is told the payment is being confirmed and is never charged again.
    if (heldStateOf(attempt) !== null) {
      throw new ConflictException(HELD_PAYMENT_MESSAGE);
    }

    if (attempt.status === 'PENDING') {
      // ESP-03 PR 4 — saved but never sent to the payment provider long
      // after it was created: the request that created it stopped before
      // charging. Nothing was charged and nothing will be; its saved
      // checkout (guest contact) is removed and the customer starts again.
      // It is never charged from here.
      // ESP-03 PR 6 — the saved checkout is only removed AFTER the attempt
      // is closed by the conditional update from NOT_SENT (which the charge
      // claim also needs), so a request that is merely slow can never be
      // charged without its saved checkout.
      if (
        attempt.paymentState === 'NOT_SENT' &&
        Date.now() - attempt.createdAt.getTime() > STRANDED_ATTEMPT_MS &&
        (await this.abandonIfNeverSent(attempt))
      ) {
        throw new ConflictException(
          'This checkout was interrupted before any payment was taken. ' +
            'Nothing was charged. Please start a new checkout.',
        );
      }
      throw new ConflictException('This checkout is already being processed.');
    }

    if (attempt.status === 'DECLINED' || attempt.status === 'FAILED') {
      const outcome = attempt.status === 'DECLINED' ? 'declined' : 'failed';
      throw new HttpException(
        { outcome, message: customerPaymentMessage(outcome) },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    // SUCCEEDED. ESP-03 PR 4 — the order exists (replayed), or it is
    // created now from the saved checkout: the first attempt crashed, failed
    // to write, or is still running (the payment row lock makes the two meet
    // on one order). Never from this retried request, never charged again.
    const order = await this.prisma.order.findUnique({
      where: { paymentAttemptId: attempt.id },
      include: ORDER_INCLUDE,
    });
    if (order) {
      return this.toConfirmation(order);
    }
    const hasSavedCheckout =
      attempt.paymentState === 'SUCCEEDED' &&
      (await this.prisma.checkoutSnapshot.count({
        where: { tenantId: attempt.tenantId, paymentAttemptId: attempt.id },
      })) > 0;
    // ESP-03 PR 6 — a session payment always had a saved checkout: one that
    // is gone without its order is flagged for review by fulfilFromSnapshot.
    if (hasSavedCheckout || attempt.checkoutSessionId !== null) {
      try {
        return await this.fulfilFromSnapshot(attempt);
      } catch (error) {
        // Recorded for review by fulfilFromSnapshot. A business reason the
        // order cannot be created now (the payment is not confirmed, the
        // saved checkout is unreadable, the price or cart changed) is under
        // review; anything else (the database briefly unavailable) is worth
        // a retry. Either way the customer must not pay again.
        if (
          error instanceof UnreadableCheckoutSnapshotError ||
          (error instanceof HttpException && error.getStatus() < 500)
        ) {
          throw new ConflictException(manualReviewMessage(attempt.id));
        }
        throw new ServiceUnavailableException(FULFILMENT_RETRY_MESSAGE);
      }
    }

    // A payment from before ESP-03 PR 4 (no saved checkout).
    if (attempt.reconciliationRequired) {
      // The order transaction ran and failed — durably recorded, never
      // charged again, never silently treated as success or failure.
      throw new ConflictException(manualReviewMessage(attempt.id));
    }

    // Payment succeeded and the order-creation transaction hasn't committed
    // (or failed) yet — genuinely still in progress, not an error.
    throw new ConflictException('This checkout is already being processed.');
  }

  private async markReconciliationRequired(
    paymentAttemptId: string,
    error: unknown,
  ): Promise<void> {
    const reason =
      error instanceof Error
        ? error.message
        : 'Unknown error creating the order after a successful payment.';

    await this.prisma.paymentAttempt.update({
      where: { id: paymentAttemptId },
      data: {
        reconciliationRequired: true,
        reconciliationReason: reason.slice(0, 500),
        reconciliationDetectedAt: new Date(),
      },
    });
  }

  private async createPaymentAttempt(
    session: CheckoutSessionRow,
    requestFingerprint: string,
    locationId: string,
    amount: number,
    currency: string,
    tenantId: string,
    snapshot: SavedCheckout,
    holds: HoldRequest,
  ): Promise<
    | { wasCreatedByThisRequest: true; attempt: PaymentAttemptRow }
    | { wasCreatedByThisRequest: false; attempt: PaymentAttemptRow }
  > {
    const findLive = (db: Prisma.TransactionClient | PrismaService) =>
      db.paymentAttempt.findFirst({
        where: {
          tenantId: session.tenantId,
          checkoutSessionId: session.id,
          status: { notIn: ['DECLINED', 'FAILED'] },
        },
      });
    try {
      // ESP-03 PR 4 — one transaction: the attempt never exists without its
      // saved checkout, and both are committed before any charge. ESP-03
      // PR 6 — the session row is locked first, so concurrent submissions
      // for one checkout are serialised: only one creates its live attempt
      // (the partial unique index enforces the same in the database).
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM "CheckoutSession"
          WHERE id = ${session.id} AND "tenantId" = ${session.tenantId}
          FOR UPDATE`;
        const raced = await findLive(tx);
        if (raced) {
          return { wasCreatedByThisRequest: false as const, attempt: raced };
        }
        const row = await tx.paymentAttempt.create({
          data: {
            tenantId,
            // ESP-03 PR 6 — generated by the server, never by a client.
            idempotencyKey: generatePaymentKey('ck'),
            checkoutSessionId: session.id,
            requestFingerprint,
            // The provider actually bound (audit: a simulated payment is
            // always recorded as such).
            provider: this.paymentProvider.name,
            locationId,
            amount,
            currency,
            paymentState: 'NOT_SENT',
            fulfilmentStatus: 'PENDING',
          },
        });
        await tx.checkoutSnapshot.create({
          data: {
            tenantId,
            paymentAttemptId: row.id,
            version: snapshot.frozen
              ? FROZEN_CHECKOUT_SNAPSHOT_VERSION
              : LEGACY_CHECKOUT_SNAPSHOT_VERSION,
            payload: snapshot as unknown as Prisma.InputJsonObject,
          },
        });
        // ESP-03 PR 8 — the promotion redemption, gift-card amount and Mocha
        // Beans this payment will spend, reserved under their locks in this
        // same transaction. Anything no longer available rolls everything
        // back (no attempt, no saved checkout, no hold) and nothing is
        // charged.
        await reserveFinancialHolds(tx, tenantId, row.id, holds);
        return { wasCreatedByThisRequest: true as const, attempt: row };
      });
    } catch (error) {
      // Checked structurally (not via `instanceof Prisma.PrismaClientKnownRequestError`)
      // because a genuinely concurrent unique-constraint violation can
      // surface through a different error identity than the one this
      // module's own Prisma import resolves to. Here it can only be the
      // one-live-attempt-per-session index: a concurrent submission won.
      if (isUniqueConstraintViolation(error)) {
        const attempt = await findLive(this.prisma);
        if (attempt) return { wasCreatedByThisRequest: false, attempt };
      }
      throw error;
    }
  }

  private async createOrderTransactionally(
    attempt: PaymentAttemptRow,
    // ESP-03 PR 4 — the saved checkout: the ONLY source of what the order
    // contains. SC2b — its plan features were decided before payment and
    // are used as-is, so a plan change mid-payment cannot make this
    // transaction disagree with what was charged.
    checkout: SavedCheckout,
  ): Promise<OrderWithRelations> {
    const paymentAttemptId = attempt.id;
    // Milestone S0D-2C-1 — the attempt was written under the tenant of the
    // server-validated Location; the Order and everything created with it
    // inherit that ownership.
    const tenantId = attempt.tenantId;
    const request = {
      locationId: checkout.locationId,
      lines: checkout.lines,
      guest: checkout.guest,
    };
    const { customerId, rewardId, couponCode, features } = checkout;
    const giftCardPlan = giftCardPlanOf(checkout, tenantId);
    return this.prisma.$transaction(async (tx) => {
      // ESP-03 PR 4 — exactly once. The payment row lock serialises every
      // path that can create this payment's order (the first attempt, a
      // retry, a recovery); the payment must be definitively charged, and an
      // order that already exists is returned as it is.
      const locked = await tx.$queryRaw<
        { status: string; paymentState: string | null }[]
      >`
        SELECT status::text AS status, "paymentState"
        FROM "PaymentAttempt"
        WHERE id = ${paymentAttemptId} AND "tenantId" = ${tenantId}
        FOR UPDATE`;
      if (
        locked.length !== 1 ||
        locked[0].status !== 'SUCCEEDED' ||
        locked[0].paymentState !== 'SUCCEEDED'
      ) {
        throw new PaymentNotConfirmedError();
      }
      const already = await tx.order.findUnique({
        where: { paymentAttemptId },
        include: ORDER_INCLUDE,
      });
      if (already) {
        return already;
      }

      // ESP-03 PR 7 — what the order contains and what it was charged for.
      // A frozen (version 2) checkout is used EXACTLY as frozen — never
      // re-priced — after its arithmetic is verified against the payment and
      // the business and location are checked to still take orders. A
      // version-1 checkout (a payment from before PR 7) is re-priced and
      // re-validated as before.
      let priced: {
        currency: string;
        subtotal: number;
        lines: FrozenLine[];
      };
      let regularPlan: RegularDiscountPlan | null;
      let regularDiscount: number;
      let plan: RedemptionPlan | null = null;
      let rewardDiscount = 0;
      let giftCardTender: number;
      if (checkout.frozen) {
        const frozen = checkout.frozen;
        try {
          verifyFrozenCheckout({ ...checkout, frozen }, attempt);
        } catch (error) {
          if (error instanceof FrozenCheckoutMismatchError) {
            throw new ConflictException(
              `Payment succeeded but its saved checkout could not be verified. ` +
                `Reference ${paymentAttemptId} for support.`,
            );
          }
          throw error;
        }
        await this.assertStillTakingOrders(
          tx,
          tenantId,
          request.locationId,
          paymentAttemptId,
        );
        priced = {
          currency: frozen.currency,
          subtotal: frozen.subtotal,
          lines: frozen.lines,
        };
        regularPlan = frozen.regularPlan;
        regularDiscount = frozen.totals.promotionDiscount;
        // A reward is only ever frozen for a member with loyalty in the
        // plan; anything else would charge a discount nobody redeems.
        if (
          frozen.rewardPlan !== null &&
          (customerId === null || !features.loyalty)
        ) {
          throw new ConflictException(
            `Payment succeeded but its saved checkout could not be verified. ` +
              `Reference ${paymentAttemptId} for support.`,
          );
        }
        // The frozen reward is honoured as frozen, but it must still be one
        // of this business's rewards (never a dangling or foreign id).
        if (
          frozen.rewardPlan !== null &&
          !(await tx.loyaltyReward.findFirst({
            where: { id: frozen.rewardPlan.rewardId, tenantId },
            select: { id: true },
          }))
        ) {
          throw new ConflictException(
            `Payment succeeded but its reward is no longer available. ` +
              `Reference ${paymentAttemptId} for support.`,
          );
        }
        plan = frozen.rewardPlan;
        rewardDiscount = frozen.totals.rewardDiscount;
        giftCardTender = frozen.totals.giftCardTender;
      } else {
        // Revalidate against the current catalog state — payment succeeding
        // does not itself guarantee nothing changed in the window since the
        // first repricing pass.
        const menu = await this.locationsService.findMenu(
          request.locationId,
          tenantId,
          tx,
        );
        if (!menu) {
          throw new ConflictException(
            `Payment succeeded but this location is no longer orderable. ` +
              `Reference ${paymentAttemptId} for support.`,
          );
        }

        const repriced = priceCart(menu, request.lines);
        if (!repriced.ok) {
          throw new ConflictException(
            `Payment succeeded but your cart changed before the order could ` +
              `be placed (${repriced.error.message}). Reference ${paymentAttemptId} for support.`,
          );
        }

        // Milestone 7E — re-resolve the regular Promotion/Coupon against the
        // CURRENT promotion state (dates, location, applicability, minimum,
        // limits) and the freshly repriced cart. The authoritative
        // redemption-count enforcement happens in applyRedemption below.
        const regularResolution: RegularDiscountResolution = features.promotions
          ? await this.promotionService.resolveRegularDiscount({
              tenantId,
              db: tx,
              priced: repriced,
              menu,
              locationId: request.locationId,
              customerId,
              couponCode,
            })
          : NO_REGULAR_DISCOUNT;
        if (regularResolution.outcome === 'coupon_rejected') {
          throw new ConflictException(
            `Payment succeeded but your coupon is no longer valid ` +
              `(${regularResolution.message}). Reference ${paymentAttemptId} for support.`,
          );
        }
        regularPlan =
          regularResolution.outcome === 'applied'
            ? regularResolution.plan
            : null;
        regularDiscount = regularPlan?.discountMinorUnits ?? 0;
        const merchandiseAfterRegular = repriced.subtotal - regularDiscount;

        // Milestone 7C — re-validate the chosen reward against the CURRENT
        // reward configuration and the freshly repriced, regular-discounted
        // cart. If the final expected charge differs from what was actually
        // captured, the whole order fails and the payment is flagged
        // reconciliationRequired — never a silent mismatch, never a false
        // success.
        if (rewardId !== null && customerId !== null && features.loyalty) {
          plan = await this.redemptionService.buildRedemptionPlan(
            rewardId,
            repriced,
            menu,
            tenantId,
            regularRewardContext(regularPlan, merchandiseAfterRegular),
          );
          rewardDiscount = plan.discountMinorUnits;
        }
        // Milestone 7G — the planned gift-card tender was fixed BEFORE payment
        // and baked into attempt.amount (external charge = owed − tender). It
        // is never re-sized here; applyRedemption below re-validates that the
        // locked card can still satisfy this exact amount, or the whole
        // transaction rolls back to reconciliation.
        giftCardTender = giftCardPlan?.plannedTenderMinorUnits ?? 0;
        if (
          repriced.subtotal -
            regularDiscount -
            rewardDiscount -
            giftCardTender !==
          attempt.amount
        ) {
          throw new ConflictException(
            `Payment succeeded but the discount, reward, gift card or cart changed ` +
              `before the order could be placed. Reference ${paymentAttemptId} for support.`,
          );
        }
        priced = repriced;
      }

      let orderNumber: string | null = null;
      for (let i = 0; i < MAX_ORDER_NUMBER_ATTEMPTS; i++) {
        const candidate = generateOrderNumber();
        const collision = await tx.order.findUnique({
          where: { orderNumber: candidate },
          select: { id: true },
        });
        if (!collision) {
          orderNumber = candidate;
          break;
        }
      }
      if (!orderNumber) {
        // ESP-03 PR 5 — transient (a retry draws new numbers): a 503, so a
        // retry or a recovery treats it as worth trying again.
        throw new ServiceUnavailableException(
          'Could not allocate an order number. Please try again.',
        );
      }

      const order = await tx.order.create({
        data: {
          tenantId,
          orderNumber,
          accessToken: generateOrderAccessToken(),
          locationId: request.locationId,
          customerId,
          paymentAttemptId,
          guestName: request.guest.name.trim(),
          guestPhone: request.guest.phone.trim(),
          guestEmail: request.guest.email?.trim() || null,
          currency: priced.currency,
          subtotal: priced.subtotal,
          promotionDiscountMinorUnits: regularDiscount,
          rewardDiscountMinorUnits: rewardDiscount,
          giftCardTenderMinorUnits: giftCardTender,
          status: 'RECEIVED',
          // Security 4C-3 — nested lines and history take their tenantId
          // from this Order through the composite (tenantId, orderId) key, so
          // they can never belong to another business.
          lines: {
            create: priced.lines.map((line) => ({
              productId: line.productId,
              productName: line.productName,
              unitPrice: line.unitPrice,
              quantity: line.quantity,
              lineTotal: line.lineTotal,
              currency: line.currency,
              selections: line.selectionSnapshots,
            })),
          },
          statusHistory: {
            create: { status: 'RECEIVED' },
          },
        },
        include: { location: true },
      });

      // Genuine transactional outbox: committed atomically with the order
      // above. Nothing reads this table yet — that's the Store Queue
      // consumer slice. Milestone S0D-2C-1 — the event carries its Order's
      // tenant (OutboxEvent.tenantId itself stays nullable until S0D-2C-2).
      await tx.outboxEvent.create({
        data: {
          tenantId: order.tenantId,
          aggregateType: 'Order',
          aggregateId: order.id,
          eventType: 'order.checkout.completed',
          payload: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            locationId: order.locationId,
            locationName: order.location.name,
            guestName: order.guestName,
            guestPhone: order.guestPhone,
            subtotal: order.subtotal,
            currency: order.currency,
            lines: priced.lines.map((line) => ({
              productId: line.productId,
              productName: line.productName,
              quantity: line.quantity,
            })),
            promotionDiscount: regularDiscount,
            rewardDiscount,
          },
        },
      });

      // ESP-03 PR 8 — what this payment reserved must be exactly what the
      // order applies below (a payment from before PR 8 reserves it now,
      // against what other payments hold); otherwise the order is not
      // created and the payment is kept for review.
      const holds = holdRequestOf(
        customerId,
        features,
        regularPlan,
        plan,
        giftCardPlan,
      );
      await prepareHoldsForOrder(tx, tenantId, paymentAttemptId, holds);

      // Milestone 7E — the regular Promotion/Coupon: the immutable snapshot
      // plus the concurrency-safe conditional increments of the total and
      // per-customer redemption counters. Applies to guest orders too
      // (a Promotion/Coupon with a per-customer limit already required
      // sign-in). A limit won at the last moment by a concurrent order makes
      // this throw -> reconciliationRequired.
      if (regularPlan !== null) {
        await this.promotionService.applyRedemption(tx, {
          tenantId,
          orderId: order.id,
          customerId,
          // ESP-03 PR 7 — a frozen discount is honoured, but never past the
          // promotion's CURRENT configured limits (owner decision D2): an
          // exhausted limit fails the order transaction, and the payment is
          // kept for review — never re-priced, never charged again.
          plan: checkout.frozen
            ? await this.withCurrentLimits(
                tx,
                tenantId,
                regularPlan,
                paymentAttemptId,
              )
            : regularPlan,
        });
      }

      // Milestone 7G — apply the gift card as tender: lock the GiftCard row,
      // re-validate ACTIVE + currency + that the locked balance still covers
      // the EXACT planned tender, then write the immutable
      // OrderGiftCardRedemption snapshot + the negative REDEMPTION ledger
      // entry + the materialized balance decrement — all in this same
      // transaction. If the card can no longer satisfy the planned tender
      // (a concurrent redemption or an HQ correction), this throws ->
      // reconciliationRequired: the external payment stays SUCCEEDED, the
      // gift card is left whole, and no redemption is recorded. The planned
      // tender is NEVER silently reduced. Works for guest orders too.
      // OrderGiftCardRedemption.orderId @unique and the partial unique index
      // on (orderId) WHERE type = 'REDEMPTION' make this exactly-once per
      // order, so a checkout replay can never spend the card twice.
      if (giftCardPlan !== null) {
        await this.giftCardRedemptionService.applyRedemption(tx, {
          orderId: order.id,
          plan: giftCardPlan,
        });
      }

      // Milestone 7C — spend Beans on the chosen reward and Milestone 7A —
      // earn Beans on the post-discount qualifying subtotal, BOTH in this
      // same transaction as the Order. Order of operations:
      //   1. applyRedemption locks the loyalty account FOR UPDATE, re-reads
      //      the balance, and (only if enough Beans remain) writes the
      //      immutable redemption snapshot, the negative REDEEM ledger
      //      entry, and the balance decrement. A concurrent order that
      //      spent the Beans first makes this throw -> reconciliationRequired.
      //   2. earnForOrder writes the positive EARN entry on
      //      (subtotal - rewardDiscount). The FOR UPDATE lock from step 1
      //      is still held, so this is safe.
      // A guest order earns and redeems nothing. `@@unique([type, orderId])`
      // on the ledger makes REDEEM and EARN each exactly-once per order.
      // SC2b — nothing is earned, redeemed or awarded when the plan did not
      // include loyalty at submission. The customer's balance is untouched.
      if (customerId !== null && features.loyalty) {
        if (plan !== null) {
          await this.redemptionService.applyRedemption(tx, {
            tenantId,
            orderId: order.id,
            customerId,
            plan,
          });
        }
        if (checkout.frozen) {
          // ESP-03 PR 7 — exactly the Beans frozen at checkout (owner
          // decision D4): the standard EARN and any BONUS_EARN, each exactly
          // once per order by its ledger unique key.
          const frozenLoyalty = checkout.frozen.loyalty;
          if (frozenLoyalty !== null) {
            await this.loyaltyService.applyEarning(tx, {
              tenantId,
              customerId,
              orderId: order.id,
              beans: frozenLoyalty.earnBeans,
            });
            if (frozenLoyalty.bonus !== null) {
              await this.bonusService.applyBonusPlan(tx, {
                tenantId,
                customerId,
                orderId: order.id,
                plan: frozenLoyalty.bonus,
              });
            }
          }
        } else {
          // Milestone 7A/7B/7E — standard Beans on the FINAL post-discount
          // qualifying merchandise (gross - regular discount - reward discount).
          await this.loyaltyService.earnForOrder({
            tx,
            tenantId,
            customerId,
            orderId: order.id,
            qualifyingSubtotalMinorUnits:
              priced.subtotal - regularDiscount - rewardDiscount,
            currency: priced.currency,
          });
          // Milestone 7D/7E — award any Bonus Mocha Bean Promotions on
          // qualifying items, as a dedicated positive BONUS_EARN entry, in
          // this same transaction. Uses CURRENT promotion state and the
          // qualifying spend that remains after BOTH the regular
          // Promotion/Coupon and the Mocha Bean reward: every FREE_ITEM freed
          // unit earns no bonus; every non-free order-level discount is summed
          // and allocated across items proportionally. Writes nothing when no
          // bonus promotion applies.
          await this.bonusService.applyBonusForOrder({
            tx,
            tenantId,
            customerId,
            orderId: order.id,
            locationId: request.locationId,
            currency: priced.currency,
            pricedLines: priced.lines.map((line) => ({
              productId: line.productId,
              productName: line.productName,
              unitPrice: line.unitPrice,
              quantity: line.quantity,
            })),
            freeUnitLineIndices: freedUnitLineIndices(regularPlan, plan),
            orderLevelDiscounts: orderLevelDiscountBuckets(
              regularPlan,
              regularDiscount,
              plan,
              rewardDiscount,
            ),
          });
        }
      }

      // ESP-03 PR 8 — the reservations are spent: consumed exactly once, in
      // this same transaction.
      await consumeHoldsForOrder(tx, tenantId, paymentAttemptId);

      // ESP-03 PR 4 — fulfilled: the saved checkout has served its purpose
      // and goes in this same transaction; any open case for this payment is
      // resolved as fulfilled.
      await tx.checkoutSnapshot.deleteMany({
        where: { tenantId, paymentAttemptId },
      });
      await tx.paymentAttempt.updateMany({
        where: { id: paymentAttemptId, tenantId },
        data: { fulfilmentStatus: 'DONE', reconciliationRequired: false },
      });
      await resolveCaseAsFulfilled(tx, tenantId, paymentAttemptId, {
        orderId: order.id,
      });

      // Re-fetch so the confirmation sees the redemption snapshot written
      // above (the initial create ran before applyRedemption).
      return tx.order.findUniqueOrThrow({
        where: { id: order.id },
        include: ORDER_INCLUDE,
      });
    });
  }

  // ESP-03 PR 7 (owner decision D5) — a frozen order ignores ordinary menu,
  // modifier and price changes, but never the business's operational
  // restrictions: a suspended business, or a location that is inactive or
  // no longer takes online orders, receives no new order. The payment is
  // then kept for review (never re-priced, never charged again).
  private async assertStillTakingOrders(
    tx: Prisma.TransactionClient,
    tenantId: string,
    locationId: string,
    paymentAttemptId: string,
  ): Promise<void> {
    const location = await tx.location.findFirst({
      where: { id: locationId, tenantId },
      select: {
        isActive: true,
        isDigitalOrderingEnabled: true,
        tenant: { select: { status: true } },
      },
    });
    if (
      !location ||
      !location.isActive ||
      !location.isDigitalOrderingEnabled ||
      location.tenant.status !== 'ACTIVE'
    ) {
      throw new ConflictException(
        `Payment succeeded but this location is not taking orders right now. ` +
          `Reference ${paymentAttemptId} for support.`,
      );
    }
  }

  // ESP-03 PR 7 (owner decision D2) — the frozen discount with the
  // promotion's CURRENT configured redemption limits, so a limit is never
  // silently exceeded. A promotion that no longer exists refuses.
  private async withCurrentLimits(
    tx: Prisma.TransactionClient,
    tenantId: string,
    plan: RegularDiscountPlan,
    paymentAttemptId: string,
  ): Promise<RegularDiscountPlan> {
    // Locked until this transaction ends, so a limit changed concurrently
    // cannot be read stale and then exceeded by the redemption below.
    const [current] = await tx.$queryRaw<
      {
        totalRedemptionLimit: number | null;
        perCustomerRedemptionLimit: number | null;
      }[]
    >`
      SELECT "totalRedemptionLimit", "perCustomerRedemptionLimit"
        FROM "Promotion"
       WHERE id = ${plan.promotionId} AND "tenantId" = ${tenantId}
       FOR UPDATE`;
    if (!current) {
      throw new ConflictException(
        `Payment succeeded but its offer is no longer available. ` +
          `Reference ${paymentAttemptId} for support.`,
      );
    }
    return {
      ...plan,
      totalRedemptionLimit: current.totalRedemptionLimit,
      perCustomerRedemptionLimit: current.perCustomerRedemptionLimit,
    };
  }

  private toConfirmation(order: OrderWithRelations): OrderConfirmation {
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      accessToken: order.accessToken,
      status: order.status,
      locationId: order.locationId,
      locationName: order.location.name,
      guestName: order.guestName,
      subtotal: order.subtotal,
      promotionDiscount: order.promotionDiscountMinorUnits,
      rewardDiscount: order.rewardDiscountMinorUnits,
      total:
        order.subtotal -
        order.promotionDiscountMinorUnits -
        order.rewardDiscountMinorUnits,
      giftCardTenderMinorUnits: order.giftCardTenderMinorUnits,
      externalPaymentMinorUnits:
        order.subtotal -
        order.promotionDiscountMinorUnits -
        order.rewardDiscountMinorUnits -
        order.giftCardTenderMinorUnits,
      currency: order.currency,
      lines: order.lines.map(toOrderLineSummary),
      orderPromotion: toOrderPromotionSummary(order.promotionRedemption),
      loyaltyReward: toOrderLoyaltyRewardSummary(order.loyaltyRewardRedemption),
      loyaltyBonus: toOrderLoyaltyBonusSummary(order.loyaltyBonus),
      orderGiftCard: toOrderGiftCardSummary(order.giftCardRedemption),
      createdAt: order.createdAt.toISOString(),
    };
  }
}

// Trim a client-supplied coupon code to a non-empty string or null. The
// authoritative normalization (upper-case + charset check) lives in
// PromotionCheckoutService / normalizeCouponCode.
function normalizeRequestCoupon(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Trim a client-supplied gift-card code to a non-empty string or null. The
// authoritative canonicalization + HMAC hashing lives in
// GiftCardRedemptionService / gift-card-code.
function normalizeRequestGiftCardCode(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Customer-facing messages for the read-only gift-card quote (Milestone 7G).
// Deliberately generic for `not_found` (never reveals malformed vs unknown).
const GIFT_CARD_QUOTE_MESSAGE: Record<
  'not_found' | 'inactive' | 'no_balance' | 'currency_mismatch',
  string
> = {
  not_found: "We couldn't find that gift card.",
  inactive: 'That gift card is inactive and cannot be used.',
  no_balance: 'That gift card has no available balance.',
  currency_mismatch: "That gift card's currency doesn't match this order.",
};

// The context the Mocha Bean reward computation needs when a regular
// Promotion/Coupon has already discounted the cart: the merchandise ceiling
// (so a FIXED reward is capped at what remains) and the unit the regular
// discount already freed (so a FREE_ITEM reward picks a different one).
// Returns undefined when there is no regular discount — the 7C path is then
// completely unchanged.
function regularRewardContext(
  regularPlan: RegularDiscountPlan | null,
  merchandiseAfterRegular: number,
): RegularDiscountContext | undefined {
  if (regularPlan === null) {
    return undefined;
  }
  return {
    merchandiseAfterRegularMinorUnits: merchandiseAfterRegular,
    regularFreeItemLineIndex:
      regularPlan.discountType === 'FREE_ITEM'
        ? (regularPlan.freeItem?.lineIndex ?? null)
        : null,
  };
}

// The exact priced-line indices of every unit made free by a FREE_ITEM
// regular Promotion/Coupon and/or a FREE_ITEM Mocha Bean reward — passed to
// 7D bonus earning so those exact units earn no bonus. The same index may
// appear twice (a promotion and a reward each freed a unit of that line).
// ESP-03 PR 8 — what a payment reserves, and what its order spends: the
// promotion redemption (with the customer, null for a guest), the gift-card
// tender and the reward's Mocha Beans (only for a member with loyalty in
// the plan — exactly when the order transaction redeems it).
function holdRequestOf(
  customerId: string | null,
  features: { loyalty: boolean },
  regularPlan: RegularDiscountPlan | null,
  rewardPlan: RedemptionPlan | null,
  giftCardPlan: GiftCardTenderPlan | null,
): HoldRequest {
  return {
    promotion: regularPlan
      ? { promotionId: regularPlan.promotionId, customerId }
      : null,
    giftCard:
      giftCardPlan && giftCardPlan.plannedTenderMinorUnits > 0
        ? {
            giftCardId: giftCardPlan.giftCardId,
            currency: giftCardPlan.currency,
            amount: giftCardPlan.plannedTenderMinorUnits,
          }
        : null,
    loyalty:
      rewardPlan &&
      rewardPlan.beanCost > 0 &&
      customerId !== null &&
      features.loyalty
        ? { customerId, beanCost: rewardPlan.beanCost }
        : null,
  };
}

function freedUnitLineIndices(
  regularPlan: RegularDiscountPlan | null,
  rewardPlan: RedemptionPlan | null,
): number[] {
  const indices: number[] = [];
  if (
    regularPlan?.discountType === 'FREE_ITEM' &&
    regularPlan.freeItem != null
  ) {
    indices.push(regularPlan.freeItem.lineIndex);
  }
  if (rewardPlan?.rewardType === 'FREE_ITEM' && rewardPlan.freeItem != null) {
    indices.push(rewardPlan.freeItem.lineIndex);
  }
  return indices;
}

// Every non-free monetary discount as a bucket carrying the products it
// actually applied to: a FIXED_AMOUNT Mocha Bean reward and an ENTIRE_ORDER
// Promotion/Coupon are order-wide (`eligibleProductIds: null`); a
// SELECTED_PRODUCTS / SELECTED_CATEGORIES Promotion/Coupon carries only its
// eligible products, so 7D bonus earning never reduces an unrelated
// product's qualifying spend.
function orderLevelDiscountBuckets(
  regularPlan: RegularDiscountPlan | null,
  regularDiscount: number,
  rewardPlan: RedemptionPlan | null,
  rewardDiscount: number,
): { amountMinorUnits: number; eligibleProductIds: string[] | null }[] {
  const buckets: {
    amountMinorUnits: number;
    eligibleProductIds: string[] | null;
  }[] = [];
  if (
    regularPlan !== null &&
    regularPlan.discountType !== 'FREE_ITEM' &&
    regularDiscount > 0
  ) {
    buckets.push({
      amountMinorUnits: regularDiscount,
      eligibleProductIds: regularPlan.discountEligibleProductIds,
    });
  }
  if (rewardPlan?.rewardType === 'FIXED_AMOUNT' && rewardDiscount > 0) {
    buckets.push({
      amountMinorUnits: rewardDiscount,
      eligibleProductIds: null,
    });
  }
  return buckets;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}
