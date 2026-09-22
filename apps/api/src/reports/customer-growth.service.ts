import { Injectable } from '@nestjs/common';
import type { AdminCustomerGrowthReport } from '@mocha-house/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthorizationContext } from '../internal-auth/authorization/authorization-context';
import {
  businessDateRangeToUtcInstants,
  MOCHA_HOUSE_TIME_ZONE,
} from '../operations/application/business-date';
import { requireReportDateRange } from './report-date-range';

export interface CustomerGrowthQuery {
  startDate?: string;
  endDate?: string;
}

// Milestone 9D — HQ Customer Growth & Ordering. Read-only. `Customer` and
// `Order` both use real timestamp columns (`createdAt`), so this uses the
// exact same business-calendar-to-UTC-instant strategy as 9A/9B
// (`businessDateRangeToUtcInstants`) — NOT 9C's `@db.Date` direct-range
// strategy, which only applies to `ChecklistInstance.businessDate`.
//
// This is customer-base SIZE and digital-ordering PARTICIPATION during a
// period — deliberately not retention, churn, conversion, lifetime value,
// scoring, or segmentation. `source.scope` is "CUSTOMER_PLATFORM": this
// report combines Customer account records with digital-platform Order
// records, never POS/in-store data.
@Injectable()
export class CustomerGrowthReportService {
  constructor(private readonly prisma: PrismaService) {}

  async getCustomerGrowthReport(
    query: CustomerGrowthQuery,
    authorization: AuthorizationContext,
  ): Promise<AdminCustomerGrowthReport> {
    // `reports.view` is CORPORATE-only in the permission catalog, so
    // PermissionGuard already rejects a LOCATION grant; this is the
    // matching service-layer defense (same pattern as 9A/9B/9C).
    authorization.assertCorporate('reports.view');

    const { startDate, endDate } = requireReportDateRange(
      query.startDate,
      query.endDate,
    );

    const { start, endExclusive } = businessDateRangeToUtcInstants(
      startDate,
      endDate,
      MOCHA_HOUSE_TIME_ZONE,
    );

    const [
      registeredCustomersAsOfEndDate,
      newRegisteredCustomers,
      orderCustomerGroups,
    ] = await Promise.all([
      // Cumulative "as of end date" — every customer created before the
      // exclusive end-of-range instant, regardless of when the range
      // starts. Deliberately not scoped to `start` — this is a running
      // total, not a period metric.
      this.prisma.customer.count({
        where: { createdAt: { lt: endExclusive } },
      }),
      this.prisma.customer.count({
        where: { createdAt: { gte: start, lt: endExclusive } },
      }),
      // One grouped query answers registeredCustomersWithOrders,
      // repeatRegisteredCustomers, registeredCustomerOrders and
      // guestOrders together — Prisma's groupBy treats every NULL
      // customerId as its own single group (standard SQL GROUP BY
      // behaviour), which is exactly the guest bucket; no Order row is
      // ever fetched in full.
      this.prisma.order.groupBy({
        by: ['customerId'],
        where: { createdAt: { gte: start, lt: endExclusive } },
        _count: { _all: true },
      }),
    ]);

    let registeredCustomersWithOrders = 0;
    let repeatRegisteredCustomers = 0;
    let registeredCustomerOrders = 0;
    let guestOrders = 0;

    for (const group of orderCustomerGroups) {
      const count = group._count._all;
      if (group.customerId === null) {
        // The guest bucket — never counted as a registered customer or
        // toward a repeat count.
        guestOrders += count;
        continue;
      }
      registeredCustomerOrders += count;
      registeredCustomersWithOrders += 1;
      if (count >= 2) {
        repeatRegisteredCustomers += 1;
      }
    }

    return {
      filters: { startDate, endDate },
      registeredCustomersAsOfEndDate,
      newRegisteredCustomers,
      registeredCustomersWithOrders,
      repeatRegisteredCustomers,
      registeredCustomerOrders,
      guestOrders,
      source: {
        scope: 'CUSTOMER_PLATFORM',
        scopeLabel:
          'Customer accounts and digital-platform orders recorded in the Mocha House platform.',
        freshnessLabel: 'Live platform data',
      },
    };
  }
}
