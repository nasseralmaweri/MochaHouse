import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  OrderStatus,
  StoreOrderDetail,
  StoreOrderSummary,
} from '@mocha-house/contracts';
import { nextOrderStatus } from '@mocha-house/domain';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@mocha-house/database';
import { toOrderLineSummary } from '../infrastructure/order-line-mapper';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';

type OrderWithLines = Prisma.OrderGetPayload<{ include: { lines: true } }>;

const VALID_ORDER_STATUSES: ReadonlySet<string> = new Set([
  'RECEIVED',
  'ACCEPTED',
  'PREPARING',
  'READY',
  'COMPLETED',
]);

function assertValidOrderStatus(value: string): asserts value is OrderStatus {
  if (!VALID_ORDER_STATUSES.has(value)) {
    throw new BadRequestException(`Unknown status "${value}".`);
  }
}

// Store-facing read/act surface over the existing Order — deliberately not
// a second authoritative record. "Active" here means both operationally
// unfinished (status != COMPLETED) *and* published for store visibility
// (its checkout OutboxEvent has been processed) — see OutboxProcessorService.
// A freshly-paid order genuinely doesn't appear here until that happens,
// which is what gives the outbox step real meaning in this slice.
@Injectable()
export class AdminOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async listActive(
    locationId: string,
    authorization: AuthorizationContext,
  ): Promise<StoreOrderSummary[]> {
    if (typeof locationId !== 'string' || locationId.trim().length === 0) {
      throw new BadRequestException('locationId is required.');
    }
    // Authorization for THIS location before any order data is read. A
    // CORPORATE grant passes for any location; a LOCATION grant only for an
    // assigned one. The query below is already constrained to this single
    // locationId, so an authorized caller can never see another store's
    // orders through this endpoint.
    authorization.assertCanActOnLocation('orders.view', locationId);

    const candidates = await this.prisma.order.findMany({
      where: { locationId, status: { not: 'COMPLETED' } },
      include: { lines: true },
      orderBy: { createdAt: 'asc' },
    });

    const publishedIds = await this.publishedOrderIds(
      candidates.map((o) => o.id),
    );

    return candidates
      .filter((order) => publishedIds.has(order.id))
      .map((order) => this.toSummary(order));
  }

  async getDetail(
    orderId: string,
    locationId: string,
    authorization: AuthorizationContext,
  ): Promise<StoreOrderDetail> {
    if (typeof locationId !== 'string' || locationId.trim().length === 0) {
      throw new BadRequestException('locationId is required.');
    }
    authorization.assertCanActOnLocation('orders.view', locationId);

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { lines: true },
    });

    if (!order || order.locationId !== locationId) {
      // Same response for "doesn't exist" and "belongs to another
      // location" — a location-scoped caller shouldn't be able to tell
      // the difference, same principle as the guest access token check.
      throw new NotFoundException('Order not found for this location.');
    }

    return { ...this.toSummary(order), guestPhone: order.guestPhone };
  }

  // No target status parameter by design — the API can only ever advance
  // one step from wherever the order actually is, so there is no request
  // shape capable of asking for an invalid transition. `expectedStatus` is
  // optimistic-concurrency (like an If-Match), not a target: it's how a
  // retried/duplicate click is told apart from a genuine conflict.
  async advance(
    orderId: string,
    locationId: string,
    expectedStatus: string,
    authorization: AuthorizationContext,
  ): Promise<{ orderId: string; status: OrderStatus; advanced: boolean }> {
    if (typeof locationId !== 'string' || locationId.trim().length === 0) {
      throw new BadRequestException('locationId is required.');
    }
    if (
      typeof expectedStatus !== 'string' ||
      expectedStatus.trim().length === 0
    ) {
      throw new BadRequestException('expectedStatus is required.');
    }
    assertValidOrderStatus(expectedStatus);
    // Authorized for the claimed location first (403 before any read)...
    authorization.assertCanActOnLocation('orders.manage_status', locationId);

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, locationId: true, status: true },
    });

    // ...then the persisted cross-check: the order must actually belong to
    // that location. A caller cannot advance another location's order by
    // supplying a locationId they happen to be authorized for.
    if (!order || order.locationId !== locationId) {
      throw new NotFoundException('Order not found for this location.');
    }

    if (order.status !== expectedStatus) {
      // The caller's view is stale. If the order is sitting exactly where
      // this same request would have left it, this is a retried/duplicate
      // call for a transition that already happened — an idempotent
      // no-op, not an error. Anything else is a genuine conflict: two
      // devices raced, or the UI is showing an old status entirely.
      const expectedNext = nextOrderStatus(expectedStatus);
      if (expectedNext !== null && order.status === expectedNext) {
        return { orderId, status: order.status, advanced: false };
      }
      throw new ConflictException(
        `Order status changed since this action was requested (now ${order.status}). Refresh and try again.`,
      );
    }

    const target = nextOrderStatus(order.status);
    if (target === null) {
      throw new ConflictException('Order is already completed.');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: { id: orderId, locationId, status: expectedStatus },
        data: { status: target },
      });

      if (updated.count === 0) {
        // Lost a race against a concurrent advance of the same order —
        // someone else's request already made this exact transition.
        // Idempotent no-op: no duplicate history row.
        return { advanced: false };
      }

      await tx.orderStatusHistory.create({
        data: { orderId, status: target },
      });

      return { advanced: true };
    });

    const current = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true },
    });

    return { orderId, status: current.status, advanced: result.advanced };
  }

  private async publishedOrderIds(orderIds: string[]): Promise<Set<string>> {
    if (orderIds.length === 0) {
      return new Set();
    }
    const events = await this.prisma.outboxEvent.findMany({
      where: {
        aggregateType: 'Order',
        aggregateId: { in: orderIds },
        status: 'PROCESSED',
      },
      select: { aggregateId: true },
    });
    return new Set(events.map((e) => e.aggregateId));
  }

  private toSummary(order: OrderWithLines): StoreOrderSummary {
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      createdAt: order.createdAt.toISOString(),
      guestName: order.guestName,
      subtotal: order.subtotal,
      currency: order.currency,
      lines: order.lines.map(toOrderLineSummary),
    };
  }
}
