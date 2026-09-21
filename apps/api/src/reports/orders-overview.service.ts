import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  AdminOrdersOverviewReport,
  OrderStatus,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthorizationContext } from '../internal-auth/authorization/authorization-context';
import {
  businessDateRangeToUtcInstants,
  MOCHA_HOUSE_TIME_ZONE,
} from '../operations/application/business-date';

export interface OrdersOverviewQuery {
  startDate?: string;
  endDate?: string;
  locationId?: string;
}

const ORDER_STATUSES: readonly OrderStatus[] = [
  'RECEIVED',
  'ACCEPTED',
  'PREPARING',
  'READY',
  'COMPLETED',
];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Milestone 9A — HQ Digital Sales & Orders overview. Read-only. This is
// deliberately a digital-platform report: there is no KwickPOS integration
// and no in-store/register order path anywhere in this codebase, so
// `Order` rows only ever come from the digital checkout flow. `source`
// below states that scope explicitly so the response can never be mistaken
// for total store sales.
@Injectable()
export class OrdersOverviewReportService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrdersOverview(
    query: OrdersOverviewQuery,
    authorization: AuthorizationContext,
  ): Promise<AdminOrdersOverviewReport> {
    // `reports.view` is CORPORATE-only in the permission catalog, so
    // PermissionGuard already rejects a LOCATION grant; this is the
    // matching service-layer defense (same pattern as AdminPlatformStatusService).
    authorization.assertCorporate('reports.view');

    const startDate = this.requireBusinessDate(query.startDate, 'startDate');
    const endDate = this.requireBusinessDate(query.endDate, 'endDate');
    if (startDate > endDate) {
      throw new BadRequestException(
        'startDate must be on or before endDate.',
      );
    }

    const locationId = this.normalizeLocationId(query.locationId);

    const [selectedLocation, availableLocations] = await Promise.all([
      locationId
        ? this.prisma.location.findUnique({
            where: { id: locationId },
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
      this.prisma.location.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    if (locationId && !selectedLocation) {
      throw new BadRequestException('Unknown location.');
    }

    const { start, endExclusive } = businessDateRangeToUtcInstants(
      startDate,
      endDate,
      MOCHA_HOUSE_TIME_ZONE,
    );

    const where: Prisma.OrderWhereInput = {
      createdAt: { gte: start, lt: endExclusive },
      ...(locationId ? { locationId } : {}),
    };

    const orders = await this.prisma.order.findMany({
      where,
      select: {
        status: true,
        subtotal: true,
        promotionDiscountMinorUnits: true,
        rewardDiscountMinorUnits: true,
      },
    });

    const totalOrders = orders.length;
    const completedOrders = orders.filter(
      (order) => order.status === 'COMPLETED',
    ).length;
    // Gift card tender is a payment method, not a discount — deliberately
    // NOT subtracted. Tax, tips and refunds are excluded because they are
    // not modelled in the current Order schema, not because they are zero.
    const digitalSalesMinorUnits = orders.reduce(
      (sum, order) =>
        sum +
        order.subtotal -
        order.promotionDiscountMinorUnits -
        order.rewardDiscountMinorUnits,
      0,
    );
    const averageOrderValueMinorUnits =
      totalOrders === 0
        ? 0
        : Math.round(digitalSalesMinorUnits / totalOrders);

    const statusBreakdown = Object.fromEntries(
      ORDER_STATUSES.map((status) => [
        status,
        orders.filter((order) => order.status === status).length,
      ]),
    ) as Record<OrderStatus, number>;

    return {
      filters: { startDate, endDate, locationId },
      location: selectedLocation,
      availableLocations,
      totalOrders,
      completedOrders,
      digitalSalesMinorUnits,
      averageOrderValueMinorUnits,
      statusBreakdown,
      source: {
        scope: 'DIGITAL_PLATFORM_ONLY',
        scopeLabel:
          'Digital-platform orders only. In-store/POS transactions are not included.',
        freshnessLabel: 'Live platform data',
      },
    };
  }

  private requireBusinessDate(
    value: string | undefined,
    field: 'startDate' | 'endDate',
  ): string {
    if (typeof value !== 'string' || !DATE_ONLY.test(value)) {
      throw new BadRequestException(
        `${field} is required and must be a valid date in YYYY-MM-DD format.`,
      );
    }
    const [year, month, day] = value.split('-').map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day
    ) {
      throw new BadRequestException(`${field} is not a valid calendar date.`);
    }
    return value;
  }

  private normalizeLocationId(value: string | undefined): string | null {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return null;
    }
    return value.trim();
  }
}
