import { timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CheckoutRequest,
  CheckoutRewardEligibilityRequest,
  CheckoutRewardEligibilityResponse,
  OrderConfirmation,
  OrderStatusResponse,
} from '@mocha-house/contracts';
import { priceCart } from '@mocha-house/domain';
import type { PaymentProvider } from '@mocha-house/integrations';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationsService } from '../../locations/application/locations.service';
import { CustomersService } from '../../customers/application/customers.service';
import { LoyaltyService } from '../../loyalty/application/loyalty.service';
import {
  LoyaltyRedemptionService,
  type RedemptionPlan,
} from '../../loyalty/application/loyalty-redemption.service';
import type { CustomerIdentity } from '../../customer-auth/infrastructure/customer-identity';
import { PAYMENT_PROVIDER } from '../infrastructure/payment-provider.token';
import {
  generateOrderAccessToken,
  generateOrderNumber,
} from '../infrastructure/order-identifiers';
import {
  toOrderLineSummary,
  toOrderLoyaltyRewardSummary,
} from '../infrastructure/order-line-mapper';

const MAX_ORDER_NUMBER_ATTEMPTS = 5;

type OrderWithRelations = Prisma.OrderGetPayload<{
  include: { lines: true; location: true; loyaltyRewardRedemption: true };
}>;

const ORDER_INCLUDE = {
  lines: true,
  location: true,
  loyaltyRewardRedemption: true,
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
    @Inject(PAYMENT_PROVIDER)
    private readonly paymentProvider: PaymentProvider,
  ) {}

  // customerIdentity is optional — sign-in is never required to check out
  // (see OrdersController's OptionalCustomerAuthGuard). When present, it
  // has already been verified by the customer-auth boundary; this method
  // never verifies a token itself.
  async checkout(
    request: CheckoutRequest,
    customerIdentity?: CustomerIdentity,
  ): Promise<OrderConfirmation> {
    this.validateRequestShape(request);

    const existingAttempt = await this.prisma.paymentAttempt.findUnique({
      where: { idempotencyKey: request.idempotencyKey },
    });

    if (existingAttempt) {
      return this.replay(existingAttempt);
    }

    // Resolved once, up front, alongside the other pre-payment steps —
    // never re-derived inside the transaction or on replay, so a
    // subsequent status/history read of this Order always reflects
    // whichever Customer (if any) was authenticated at the moment payment
    // was attempted, not whatever happens to be true later.
    const customerId = await this.resolveCustomerId(customerIdentity);

    const menu = await this.locationsService.findMenu(request.locationId);
    if (!menu) {
      throw new NotFoundException('Location or menu not found.');
    }

    const priced = priceCart(menu, request.lines);
    if (!priced.ok) {
      throw new BadRequestException(priced.error.message);
    }

    // Milestone 7C — resolve a chosen Mocha Bean reward BEFORE payment so
    // the charge is for the discounted amount. A guest that submits a
    // reward id is rejected here, before any payment attempt exists — never
    // auto-matched to an account. All numbers below are server-computed;
    // the client only sent an id.
    const rewardId =
      typeof request.loyaltyRewardId === 'string' &&
      request.loyaltyRewardId.trim().length > 0
        ? request.loyaltyRewardId.trim()
        : null;
    let prePaymentPlan: RedemptionPlan | null = null;
    if (rewardId !== null) {
      if (customerId === null) {
        throw new BadRequestException('Sign in to use a Mocha Bean reward.');
      }
      prePaymentPlan = await this.redemptionService.buildRedemptionPlan(
        rewardId,
        priced,
        menu,
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

    // The gross merchandise subtotal minus the reward discount — what the
    // customer actually pays. Guaranteed >= 0 (the discount is capped at
    // the eligible merchandise amount).
    const chargeAmount =
      priced.subtotal - (prePaymentPlan?.discountMinorUnits ?? 0);

    const created = await this.createPaymentAttempt(
      request.idempotencyKey,
      request.locationId,
      chargeAmount,
      priced.currency,
    );

    if (!created.wasCreatedByThisRequest) {
      // Another concurrent request with the same idempotency key won the
      // race to create the attempt row — never charge twice for one key,
      // fall back to whatever that request's outcome resolves to.
      return this.replay(created.attempt);
    }

    const attempt = created.attempt;

    if (chargeAmount === 0) {
      // A reward covered the entire merchandise subtotal — there is nothing
      // to charge. Skip the payment provider (a real gateway rejects a $0
      // charge) and mark the attempt succeeded so the rest of the order
      // flow, and replay, are completely unchanged.
      await this.prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { status: 'SUCCEEDED', providerReference: 'no-charge' },
      });
    } else {
      const chargeResult = await this.paymentProvider.charge({
        idempotencyKey: request.idempotencyKey,
        amount: chargeAmount,
        currency: priced.currency,
        metadata: { guestPhone: request.guest.phone },
      });

      if (chargeResult.outcome !== 'succeeded') {
        await this.prisma.paymentAttempt.update({
          where: { id: attempt.id },
          data: {
            status:
              chargeResult.outcome === 'declined' ? 'DECLINED' : 'FAILED',
            failureReason: chargeResult.reason,
          },
        });
        throw new HttpException(
          { outcome: chargeResult.outcome, message: chargeResult.reason },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }

      await this.prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'SUCCEEDED',
          providerReference: chargeResult.providerReference,
        },
      });
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
      if (customerId !== null) {
        await this.loyaltyService.ensureAccountForCustomer(customerId);
      }

      order = await this.createOrderTransactionally(
        request,
        attempt,
        customerId,
        rewardId,
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

    const customer =
      await this.customersService.resolveOrCreateFromIdentity(customerIdentity);

    const menu = await this.locationsService.findMenu(request.locationId);
    if (!menu) {
      throw new NotFoundException('Location or menu not found.');
    }
    const priced = priceCart(menu, request.lines);
    if (!priced.ok) {
      throw new BadRequestException(priced.error.message);
    }

    return this.redemptionService.previewForCart(customer.id, priced, menu);
  }

  async getStatus(
    orderId: string,
    accessToken: string,
  ): Promise<OrderStatusResponse> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
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
      rewardDiscount: order.rewardDiscountMinorUnits,
      total: order.subtotal - order.rewardDiscountMinorUnits,
      currency: order.currency,
      lines: order.lines.map(toOrderLineSummary),
      loyaltyReward: toOrderLoyaltyRewardSummary(order.loyaltyRewardRedemption),
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
  private async resolveCustomerId(
    customerIdentity: CustomerIdentity | undefined,
  ): Promise<string | null> {
    if (!customerIdentity) {
      return null;
    }
    const customer =
      await this.customersService.resolveOrCreateFromIdentity(customerIdentity);
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
    if (
      request.loyaltyRewardId !== undefined &&
      request.loyaltyRewardId !== null &&
      (typeof request.loyaltyRewardId !== 'string' ||
        request.loyaltyRewardId.trim().length === 0)
    ) {
      throw new BadRequestException('loyaltyRewardId must be a reward id or null.');
    }
  }

  private async replay(attempt: PaymentAttemptRow): Promise<OrderConfirmation> {
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
  ): Promise<
    | { wasCreatedByThisRequest: true; attempt: PaymentAttemptRow }
    | { wasCreatedByThisRequest: false; attempt: PaymentAttemptRow }
  > {
    try {
      const attempt = await this.prisma.paymentAttempt.create({
        data: {
          idempotencyKey,
          provider: 'fake',
          locationId,
          amount,
          currency,
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
  ): Promise<OrderWithRelations> {
    const paymentAttemptId = attempt.id;
    return this.prisma.$transaction(async (tx) => {
      // Revalidate against the current catalog state — payment succeeding
      // does not itself guarantee nothing changed in the window since the
      // first repricing pass.
      const menu = await this.locationsService.findMenu(request.locationId, tx);
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

      // Milestone 7C — re-validate the chosen reward against the CURRENT
      // reward configuration and the freshly repriced cart (the client
      // never locks in a stale reward by selecting it). If it no longer
      // applies, or the discounted total would differ from what was
      // actually charged, the whole order fails and the payment is flagged
      // reconciliationRequired — never a silent mismatch, never a false
      // success.
      let plan: RedemptionPlan | null = null;
      let rewardDiscount = 0;
      if (rewardId !== null && customerId !== null) {
        plan = await this.redemptionService.buildRedemptionPlan(
          rewardId,
          priced,
          menu,
        );
        rewardDiscount = plan.discountMinorUnits;
        if (priced.subtotal - rewardDiscount !== attempt.amount) {
          throw new ConflictException(
            `Payment succeeded but the reward or cart changed before the ` +
              `order could be placed. Reference ${paymentAttemptId} for support.`,
          );
        }
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
          rewardDiscountMinorUnits: rewardDiscount,
          status: 'RECEIVED',
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
      // consumer slice.
      await tx.outboxEvent.create({
        data: {
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
            rewardDiscount,
          },
        },
      });

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
      if (customerId !== null) {
        if (plan !== null) {
          await this.redemptionService.applyRedemption(tx, {
            orderId: order.id,
            customerId,
            plan,
          });
        }
        await this.loyaltyService.earnForOrder({
          tx,
          customerId,
          orderId: order.id,
          qualifyingSubtotalMinorUnits: priced.subtotal - rewardDiscount,
          currency: priced.currency,
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
      rewardDiscount: order.rewardDiscountMinorUnits,
      total: order.subtotal - order.rewardDiscountMinorUnits,
      currency: order.currency,
      lines: order.lines.map(toOrderLineSummary),
      loyaltyReward: toOrderLoyaltyRewardSummary(order.loyaltyRewardRedemption),
      createdAt: order.createdAt.toISOString(),
    };
  }
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
