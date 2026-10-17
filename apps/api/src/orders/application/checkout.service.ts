import { timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
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
import type { PaymentProvider } from '@mocha-house/integrations';
import { Prisma, type TenantContext } from '@mocha-house/database';
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
  type StorefrontFeatures,
} from '../../subscriptions/application/storefront-features.service';
import {
  GiftCardRedemptionService,
  type GiftCardTenderPlan,
} from '../../gift-cards/application/gift-card-redemption.service';
import type { CustomerIdentity } from '../../customer-auth/infrastructure/customer-identity';
import { assertValidCheckoutLines } from './validate-checkout-lines';
import { PAYMENT_PROVIDER } from '../infrastructure/payment-provider.token';
import {
  chargeAttempt,
  heldStateOf,
  HELD_PAYMENT_MESSAGE,
} from '../../payment/payment-charge';
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
  // row and its outbox event copy the attempt's. An existing attempt for
  // this idempotency key is only ever replayed for its own tenant.
  async checkout(
    request: CheckoutRequest,
    customerIdentity: CustomerIdentity | undefined,
    tenant: TenantContext,
  ): Promise<OrderConfirmation> {
    this.validateRequestShape(request);

    const existingAttempt = await this.prisma.paymentAttempt.findUnique({
      where: { idempotencyKey: request.idempotencyKey },
    });

    if (existingAttempt) {
      return this.replayOwned(existingAttempt, tenant, request.locationId);
    }

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
      const balance =
        await this.loyaltyService.getBalanceForCustomer(customerId);
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

    const created = await this.createPaymentAttempt(
      request.idempotencyKey,
      request.locationId,
      chargeAmount,
      priced.currency,
      tenantId,
    );

    if (!created.wasCreatedByThisRequest) {
      // Another concurrent request with the same idempotency key won the
      // race to create the attempt row — never charge twice for one key,
      // fall back to whatever that request's outcome resolves to (for this
      // tenant only — the winner is ownership-checked exactly like an
      // attempt found up front).
      return this.replayOwned(created.attempt, tenant, request.locationId);
    }

    const attempt = created.attempt;

    if (chargeAmount === 0) {
      // A reward and/or a gift card covered the entire amount owed — there
      // is nothing to charge externally. Skip the payment provider (a real
      // gateway rejects a $0 charge) and mark the attempt succeeded so the
      // rest of the order flow, and replay, are completely unchanged. A
      // full-gift-card order still records its REDEMPTION transactionally
      // in createOrderTransactionally below.
      await this.prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'SUCCEEDED',
          paymentState: 'SUCCEEDED',
          providerReference: 'no-charge',
        },
      });
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
        throw new HttpException(
          { outcome: charged.kind, message: charged.reason },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
      if (charged.kind === 'held' || charged.kind === 'not-claimed') {
        throw new ConflictException(HELD_PAYMENT_MESSAGE);
      }
    }

    let order: OrderWithRelations;
    try {
      // Milestone 7A — prepare the customer's loyalty account (a
      // unique-key race is swallowed inside ensureAccountForCustomer, never
      // surfaced here). This MUST stay INSIDE the post-payment try/catch:
      // any other failure here is then handled exactly like an
      // order-transaction failure — the payment stays SUCCEEDED and the
      // attempt is flagged reconciliationRequired, never silently orphaned.
      // Guests (customerId null) never earn, so this is skipped for them.
      // SC2b — only when the plan included loyalty at submission.
      if (customerId !== null && features.loyalty) {
        await this.loyaltyService.ensureAccountForCustomer(customerId);
      }

      order = await this.createOrderTransactionally(
        request,
        attempt,
        customerId,
        rewardId,
        couponCode,
        giftCardPlan,
        features,
      );
    } catch (error) {
      // Payment already succeeded (the update above committed before this
      // ever runs) but the order could not be completed — durably record
      // that as a reconciliation condition rather than letting it exist
      // only as an inferable "SUCCEEDED with no linked Order" state. No
      // refund and no automatic retry of the financial effect happens here.
      await this.markReconciliationRequired(attempt.id, error);
      throw error;
    }
    return this.toConfirmation(order);
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

    const customer = await this.customersService.resolveOrCreateFromIdentity(
      customerIdentity,
      tenant,
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

  // customerIdentity is undefined for guest checkout (no Authorization
  // header) and also whenever OptionalCustomerAuthGuard couldn't verify a
  // header that was present — both cases resolve to a plain guest order
  // (customerId: null), never an error. JIT-provisions the Customer record
  // exactly like GET /customers/me does, so a customer's very first
  // checkout can associate to their account without a prior /customers/me
  // call ever having happened.
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
    const customer = await this.customersService.resolveOrCreateFromIdentity(
      customerIdentity,
      tenant,
    );
    return customer.id;
  }

  private validateRequestShape(request: CheckoutRequest): void {
    if (
      typeof request.idempotencyKey !== 'string' ||
      request.idempotencyKey.trim().length < 8 ||
      request.idempotencyKey.length > 200
    ) {
      throw new BadRequestException(
        'A valid idempotencyKey (8-200 characters) is required.',
      );
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

  // Milestone S0D-2C-1 — idempotency keys are still GLOBALLY unique
  // (tenant-scoping them is S0D-3), so a key can name another tenant's
  // attempt. That attempt is refused BEFORE anything about it is revealed —
  // its status, its failure reason, and above all its Order confirmation
  // (which carries the order's accessToken and guest details) — with one
  // generic conflict that says nothing about what the key belongs to.
  private async replayOwned(
    attempt: PaymentAttemptRow,
    tenant: TenantContext,
    requestedLocationId: string,
  ): Promise<OrderConfirmation> {
    if (attempt.tenantId !== tenant.tenantId) {
      throw new ConflictException(
        'This idempotency key cannot be used. Start a new checkout.',
      );
    }
    // ESP-03 PR 2 — a key is bound to the request that created it. The
    // Location is the part of that request persisted on the attempt; a
    // replay naming a different one is a different request reusing the key
    // and is refused before its outcome (or any order) is revealed.
    // (Binding the cart / guest details too needs a persisted request
    // fingerprint, which needs a schema change — deferred.)
    if (attempt.locationId !== requestedLocationId) {
      throw new ConflictException(
        'This idempotency key was already used for a different checkout. Start a new checkout.',
      );
    }
    return this.replay(attempt);
  }

  private async replay(attempt: PaymentAttemptRow): Promise<OrderConfirmation> {
    // ESP-03 PR 2 — a charge whose outcome is not final is held: the client
    // is told the payment is being confirmed and is never charged again.
    if (heldStateOf(attempt) !== null) {
      throw new ConflictException(HELD_PAYMENT_MESSAGE);
    }

    if (attempt.status === 'PENDING') {
      throw new ConflictException(
        'A checkout with this idempotency key is already being processed.',
      );
    }

    if (attempt.status === 'DECLINED' || attempt.status === 'FAILED') {
      throw new HttpException(
        {
          outcome: attempt.status === 'DECLINED' ? 'declined' : 'failed',
          message: attempt.failureReason ?? 'Payment was not successful.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    // SUCCEEDED — but the Order isn't necessarily there *yet*. The status
    // update commits before the order-creation transaction starts, so a
    // concurrent replay can legitimately observe SUCCEEDED while that
    // transaction is still in flight. Handled as three distinct cases:
    if (attempt.reconciliationRequired) {
      // The order transaction ran and failed — durably recorded, never
      // charged again, never silently treated as success or failure.
      throw new ConflictException(
        `Your payment was processed but the order could not be completed ` +
          `automatically. This has been flagged for manual review — do not ` +
          `submit payment again. Reference ${attempt.id} for support.`,
      );
    }

    const order = await this.prisma.order.findUnique({
      where: { paymentAttemptId: attempt.id },
      include: ORDER_INCLUDE,
    });

    if (!order) {
      // Payment succeeded and the order-creation transaction hasn't
      // committed (or failed) yet — genuinely still in progress, not an
      // error. The caller retrying shortly will see either the completed
      // order or the reconciliationRequired branch above.
      throw new ConflictException(
        'A checkout with this idempotency key is already being processed.',
      );
    }

    return this.toConfirmation(order);
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
    idempotencyKey: string,
    locationId: string,
    amount: number,
    currency: string,
    tenantId: string,
  ): Promise<
    | { wasCreatedByThisRequest: true; attempt: PaymentAttemptRow }
    | { wasCreatedByThisRequest: false; attempt: PaymentAttemptRow }
  > {
    try {
      const attempt = await this.prisma.paymentAttempt.create({
        data: {
          tenantId,
          idempotencyKey,
          // The provider actually bound (audit: a simulated payment is
          // always recorded as such).
          provider: this.paymentProvider.name,
          locationId,
          amount,
          currency,
          paymentState: 'NOT_SENT',
        },
      });
      return { wasCreatedByThisRequest: true, attempt };
    } catch (error) {
      // Checked structurally (not via `instanceof Prisma.PrismaClientKnownRequestError`)
      // because a genuinely concurrent unique-constraint violation can
      // surface through a different error identity than the one this
      // module's own Prisma import resolves to. The idempotencyKey unique
      // constraint is the only thing this insert can violate, so any P2002
      // here unambiguously means a concurrent request won the race.
      if (isUniqueConstraintViolation(error)) {
        const attempt = await this.prisma.paymentAttempt.findUniqueOrThrow({
          where: { idempotencyKey },
        });
        return { wasCreatedByThisRequest: false, attempt };
      }
      throw error;
    }
  }

  private async createOrderTransactionally(
    request: CheckoutRequest,
    attempt: PaymentAttemptRow,
    customerId: string | null,
    rewardId: string | null,
    couponCode: string | null,
    giftCardPlan: GiftCardTenderPlan | null,
    // SC2b — the decision evaluated before payment (see checkout()). Used
    // as-is: never re-read here, so a plan change mid-payment cannot make
    // this transaction disagree with what was charged.
    features: StorefrontFeatures,
  ): Promise<OrderWithRelations> {
    const paymentAttemptId = attempt.id;
    // Milestone S0D-2C-1 — the attempt was written under the tenant of the
    // server-validated Location; the Order and everything created with it
    // inherit that ownership.
    const tenantId = attempt.tenantId;
    return this.prisma.$transaction(async (tx) => {
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

      const priced = priceCart(menu, request.lines);
      if (!priced.ok) {
        throw new ConflictException(
          `Payment succeeded but your cart changed before the order could ` +
            `be placed (${priced.error.message}). Reference ${paymentAttemptId} for support.`,
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
            priced,
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
      const regularPlan =
        regularResolution.outcome === 'applied' ? regularResolution.plan : null;
      const regularDiscount = regularPlan?.discountMinorUnits ?? 0;
      const merchandiseAfterRegular = priced.subtotal - regularDiscount;

      // Milestone 7C — re-validate the chosen reward against the CURRENT
      // reward configuration and the freshly repriced, regular-discounted
      // cart. If the final expected charge differs from what was actually
      // captured, the whole order fails and the payment is flagged
      // reconciliationRequired — never a silent mismatch, never a false
      // success.
      let plan: RedemptionPlan | null = null;
      let rewardDiscount = 0;
      if (rewardId !== null && customerId !== null && features.loyalty) {
        plan = await this.redemptionService.buildRedemptionPlan(
          rewardId,
          priced,
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
      const giftCardTender = giftCardPlan?.plannedTenderMinorUnits ?? 0;
      if (
        priced.subtotal - regularDiscount - rewardDiscount - giftCardTender !==
        attempt.amount
      ) {
        throw new ConflictException(
          `Payment succeeded but the discount, reward, gift card or cart changed ` +
            `before the order could be placed. Reference ${paymentAttemptId} for support.`,
        );
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
        throw new ConflictException(
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
          plan: regularPlan,
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

      // Re-fetch so the confirmation sees the redemption snapshot written
      // above (the initial create ran before applyRedemption).
      return tx.order.findUniqueOrThrow({
        where: { id: order.id },
        include: ORDER_INCLUDE,
      });
    });
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
