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
  OrderConfirmation,
  OrderStatusResponse,
} from '@mocha-house/contracts';
import { priceCart } from '@mocha-house/domain';
import type { PaymentProvider } from '@mocha-house/integrations';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationsService } from '../../locations/application/locations.service';
import { CustomersService } from '../../customers/application/customers.service';
import type { CustomerIdentity } from '../../customer-auth/infrastructure/customer-identity';
import { PAYMENT_PROVIDER } from '../infrastructure/payment-provider.token';
import {
  generateOrderAccessToken,
  generateOrderNumber,
} from '../infrastructure/order-identifiers';
import { toOrderLineSummary } from '../infrastructure/order-line-mapper';

const MAX_ORDER_NUMBER_ATTEMPTS = 5;

type OrderWithRelations = Prisma.OrderGetPayload<{
  include: { lines: true; location: true };
}>;

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

    const created = await this.createPaymentAttempt(
      request.idempotencyKey,
      request.locationId,
      priced.subtotal,
      priced.currency,
    );

    if (!created.wasCreatedByThisRequest) {
      // Another concurrent request with the same idempotency key won the
      // race to create the attempt row — never charge twice for one key,
      // fall back to whatever that request's outcome resolves to.
      return this.replay(created.attempt);
    }

    const attempt = created.attempt;

    const chargeResult = await this.paymentProvider.charge({
      idempotencyKey: request.idempotencyKey,
      amount: priced.subtotal,
      currency: priced.currency,
      metadata: { guestPhone: request.guest.phone },
    });

    if (chargeResult.outcome !== 'succeeded') {
      await this.prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: chargeResult.outcome === 'declined' ? 'DECLINED' : 'FAILED',
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

    let order: OrderWithRelations;
    try {
      order = await this.createOrderTransactionally(
        request,
        attempt.id,
        customerId,
      );
    } catch (error) {
      // Payment already succeeded (the update above committed before this
      // ever runs) but the order transaction did not — durably record that
      // as a reconciliation condition rather than letting it exist only as
      // an inferable "SUCCEEDED with no linked Order" state. No refund and
      // no automatic retry of the financial effect happens here.
      await this.markReconciliationRequired(attempt.id, error);
      throw error;
    }
    return this.toConfirmation(order);
  }

  async getStatus(
    orderId: string,
    accessToken: string,
  ): Promise<OrderStatusResponse> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { lines: true, location: true, paymentAttempt: true },
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
      currency: order.currency,
      lines: order.lines.map(toOrderLineSummary),
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
      include: { lines: true, location: true },
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
    paymentAttemptId: string,
    customerId: string | null,
  ): Promise<OrderWithRelations> {
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
        include: { lines: true, location: true },
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
          },
        },
      });

      return order;
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
      currency: order.currency,
      lines: order.lines.map(toOrderLineSummary),
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
