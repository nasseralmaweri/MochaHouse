import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CustomerOrderDetail,
  CustomerOrderSummary,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { toOrderLineSummary } from '../infrastructure/order-line-mapper';

type OrderWithLocation = Prisma.OrderGetPayload<{
  include: { location: true };
}>;

// Read-only, customer-scoped view over the same authoritative Order table
// AdminOrdersService (store) and CheckoutService (guest confirmation) also
// read — never a separate order record. Every method here takes the
// authenticated customerId as a required parameter and folds it directly
// into the Prisma `where` clause, never as a fetch-then-compare check
// afterward, so ownership can't accidentally be forgotten on a future edit.
@Injectable()
export class CustomerOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async listForCustomer(customerId: string): Promise<CustomerOrderSummary[]> {
    const orders = await this.prisma.order.findMany({
      where: { customerId },
      include: { location: true },
      orderBy: { createdAt: 'desc' },
    });

    return orders.map((order) => this.toSummary(order));
  }

  async getDetail(
    customerId: string,
    orderId: string,
  ): Promise<CustomerOrderDetail> {
    // id + customerId together in one `where` is the ownership check —
    // an order that exists but belongs to a different customer is
    // indistinguishable here from one that doesn't exist at all, exactly
    // like the guest accessToken check in CheckoutService.getStatus.
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId },
      include: { location: true, lines: true },
    });

    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    return {
      ...this.toSummary(order),
      lines: order.lines.map(toOrderLineSummary),
    };
  }

  private toSummary(order: OrderWithLocation): CustomerOrderSummary {
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      createdAt: order.createdAt.toISOString(),
      locationName: order.location.name,
      status: order.status,
      subtotal: order.subtotal,
      currency: order.currency,
    };
  }
}
