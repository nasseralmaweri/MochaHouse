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
import {
  ACTIVE_ORDER_STATUSES,
  ALL_ORDER_STATUSES,
  nextOrderStatus,
} from '@mocha-house/domain';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, type TenantContext } from '@mocha-house/database';
import {
  toOrderGiftCardSummary,
  toOrderLineSummary,
  toOrderLoyaltyBonusSummary,
  toOrderLoyaltyRewardSummary,
  toOrderPromotionSummary,
} from '../infrastructure/order-line-mapper';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { requireTenantOwnership } from '../../tenancy/tenant-ownership';
import { toClosureSummary } from './order-closure.service';

type OrderWithLines = Prisma.OrderGetPayload<{ include: { lines: true } }>;

// The statuses a client may NAME as the status it last saw (the
// optimistic-concurrency token of "advance"). REJECTED and CANCELLED are real
// statuses an order can hold once S5b ships, but they are terminal: nothing
// advances from them, so a client naming one is told the order already moved
// (409) by the normal "expected status" mismatch, never accepted as a step.
const VALID_ORDER_STATUSES: ReadonlySet<string> = new Set<OrderStatus>(
  ALL_ORDER_STATUSES,
);

function assertValidOrderStatus(value: string): asserts value is OrderStatus {
  if (!VALID_ORDER_STATUSES.has(value)) {
    throw new BadRequestException(`Unknown status "${value}".`);
  }
}

// Store-facing read/act surface over the existing Order — deliberately not
// a second authoritative record. "Active" means the order's status is an
// ACTIVE_ORDER_STATUSES member (packages/domain) — nothing else. Visibility
// is decided ONLY by committed order state: an order the checkout
// transaction committed is in the queue immediately, whether or not the
// worker is running or its OutboxEvent has been processed. The outbox only
// drives notifications; it must never gate what the shop can see.
@Injectable()
export class AdminOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async listActive(
    locationId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
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

    // The tenant predicate is defence in depth beside the location one: a
    // location id that somehow belonged to another tenant still yields
    // nothing for this request's tenant.
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId: tenant.tenantId,
        locationId,
        status: { in: [...ACTIVE_ORDER_STATUSES] },
      },
      include: { lines: true },
      // id (uuid v7, time-ordered) breaks createdAt ties so the order is stable.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    return orders.map((order) => this.toSummary(order));
  }

  async getDetail(
    orderId: string,
    locationId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<StoreOrderDetail> {
    if (typeof locationId !== 'string' || locationId.trim().length === 0) {
      throw new BadRequestException('locationId is required.');
    }
    authorization.assertCanActOnLocation('orders.view', locationId);

    // R1 / S5b — tenant-scoped in the query itself, so another business's
    // order (and its closure note) is never even loaded.
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: tenant.tenantId },
      include: {
        lines: true,
        promotionRedemption: true,
        loyaltyRewardRedemption: true,
        loyaltyBonus: { include: { items: true } },
        giftCardRedemption: true,
        closure: {
          include: { refundObligation: { select: { status: true } } },
        },
      },
    });

    if (!order || order.locationId !== locationId) {
      // Same response for "doesn't exist" and "belongs to another
      // location" — a location-scoped caller shouldn't be able to tell
      // the difference, same principle as the guest access token check.
      throw new NotFoundException('Order not found for this location.');
    }
    // ...and "belongs to another tenant" gets the very same response.
    requireTenantOwnership(order, tenant, 'Order not found for this location.');

    return {
      ...this.toSummary(order),
      guestPhone: order.guestPhone,
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
      orderPromotion: toOrderPromotionSummary(order.promotionRedemption),
      loyaltyReward: toOrderLoyaltyRewardSummary(order.loyaltyRewardRedemption),
      loyaltyBonus: toOrderLoyaltyBonusSummary(order.loyaltyBonus),
      orderGiftCard: toOrderGiftCardSummary(order.giftCardRedemption),
      // The internal staff note is shown only to people who may close
      // orders at this location; everyone else sees the closure without it.
      closure: order.closure
        ? toClosureSummary(
            order.closure,
            authorization.canActOnLocation('orders.cancel', locationId),
          )
        : null,
    };
  }

  // No target status parameter by design — the API can only ever advance
  // one step from wherever the order actually is, so there is no request
  // shape capable of asking for an invalid transition. `expectedStatus` is
  // optimistic-concurrency (like an If-Match), not a target: it's how a
  // retried/duplicate click is told apart from a genuine conflict.
  //
  // Milestone S0D-2C-1 — `tenant` is the request's explicit TenantContext.
  // The order must belong to it (an order in another tenant is reported
  // exactly like a missing one), and the status-history row and any
  // outbox event written here copy the order's own tenant.
  async advance(
    orderId: string,
    locationId: string,
    expectedStatus: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
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
      select: { id: true, locationId: true, status: true, tenantId: true },
    });

    // ...then the persisted cross-check: the order must actually belong to
    // that location. A caller cannot advance another location's order by
    // supplying a locationId they happen to be authorized for.
    if (!order || order.locationId !== locationId) {
      throw new NotFoundException('Order not found for this location.');
    }
    // ...and to the request's tenant (same response as a missing order).
    const tenantId = requireTenantOwnership(
      order,
      tenant,
      'Order not found for this location.',
    );

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
      // COMPLETED, REJECTED or CANCELLED: all terminal, none advances.
      throw new ConflictException(
        `Order is already ${order.status.toLowerCase()}.`,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: { id: orderId, tenantId, locationId, status: expectedStatus },
        data: { status: target },
      });

      if (updated.count === 0) {
        // The order left `expectedStatus` between the read above and this
        // conditional update. Only if it is now exactly where THIS request
        // would have put it did a concurrent advance make the same
        // transition (an idempotent no-op, no duplicate history row).
        // Anything else — above all a concurrent rejection or cancellation
        // (R1 / S5b) — is a genuine conflict, never reported as success.
        const now = await tx.order.findUnique({
          where: { id: orderId },
          select: { status: true },
        });
        if (now?.status === target) {
          return { advanced: false };
        }
        throw new ConflictException(
          `Order status changed since this action was requested (now ${now?.status ?? 'unknown'}). Refresh and try again.`,
        );
      }

      await tx.orderStatusHistory.create({
        data: { tenantId, orderId, status: target },
      });

      // Milestone 8H — only READY triggers a notification (RECEIVED already
      // has its own event from checkout.service.ts; ACCEPTED/PREPARING/
      // COMPLETED have no notification in this slice). Written in the same
      // transaction as the status flip for the same reason the checkout
      // outbox write is: "the order reached READY" and "an event exists for
      // it" must never disagree. apps/worker's NotificationDispatchService
      // is the sole consumer — this module never sends anything itself.
      if (target === 'READY') {
        await tx.outboxEvent.create({
          data: {
            tenantId,
            aggregateType: 'Order',
            aggregateId: orderId,
            eventType: 'order.status.ready',
            payload: { orderId, locationId, status: target },
          },
        });
      }

      return { advanced: true };
    });

    const current = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true },
    });

    return { orderId, status: current.status, advanced: result.advanced };
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
