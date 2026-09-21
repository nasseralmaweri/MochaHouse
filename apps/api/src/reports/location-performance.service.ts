import { Injectable } from '@nestjs/common';
import type {
  AdminLocationPerformanceReport,
  AdminLocationPerformanceRow,
  OrderStatus,
} from '@mocha-house/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthorizationContext } from '../internal-auth/authorization/authorization-context';
import {
  businessDateRangeToUtcInstants,
  MOCHA_HOUSE_TIME_ZONE,
} from '../operations/application/business-date';
import { requireReportDateRange } from './report-date-range';

export interface LocationPerformanceQuery {
  startDate?: string;
  endDate?: string;
}

interface LocationTotals {
  totalOrders: number;
  completedOrders: number;
  digitalSalesMinorUnits: number;
}

// Milestone 9B — HQ Location Performance. Read-only. Same digital-platform
// scope as 9A's Digital Sales & Orders report (Milestone 9A's comment on
// OrdersOverviewReportService applies identically here) — this compares
// locations against EACH OTHER for digital ordering, never against a
// total-store/POS figure that doesn't exist in this codebase.
@Injectable()
export class LocationPerformanceReportService {
  constructor(private readonly prisma: PrismaService) {}

  async getLocationPerformance(
    query: LocationPerformanceQuery,
    authorization: AuthorizationContext,
  ): Promise<AdminLocationPerformanceReport> {
    // `reports.view` is CORPORATE-only in the permission catalog, so
    // PermissionGuard already rejects a LOCATION grant; this is the
    // matching service-layer defense (same pattern as 9A).
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

    // One aggregate query, grouped by (locationId, status) so Postgres does
    // the counting/summing — never pull every Order row into Node just to
    // fold it here. Only locations with at least one order in range appear
    // in these groups; the roster query below is what decides which
    // locations are actually shown (see the inclusion rule in the merge
    // step).
    const grouped = await this.prisma.order.groupBy({
      by: ['locationId', 'status'],
      where: { createdAt: { gte: start, lt: endExclusive } },
      _count: { _all: true },
      _sum: {
        subtotal: true,
        promotionDiscountMinorUnits: true,
        rewardDiscountMinorUnits: true,
      },
    });

    const totalsByLocation = new Map<string, LocationTotals>();
    for (const group of grouped) {
      const current = totalsByLocation.get(group.locationId) ?? {
        totalOrders: 0,
        completedOrders: 0,
        digitalSalesMinorUnits: 0,
      };
      const count = group._count._all;
      const netForGroup =
        (group._sum.subtotal ?? 0) -
        (group._sum.promotionDiscountMinorUnits ?? 0) -
        (group._sum.rewardDiscountMinorUnits ?? 0);

      current.totalOrders += count;
      current.digitalSalesMinorUnits += netForGroup;
      if ((group.status as OrderStatus) === 'COMPLETED') {
        current.completedOrders += count;
      }
      totalsByLocation.set(group.locationId, current);
    }

    // The roster, not the order data, drives which locations are shown.
    // Inclusion rule (Milestone 9B, approved): every currently active
    // location (even with zero orders in range — that's meaningful, not an
    // absence of data), PLUS any inactive location that has at least one
    // order in the selected period (preserves history without resurrecting
    // a closed location that has nothing to show for this period).
    const allLocations = await this.prisma.location.findMany({
      select: { id: true, name: true, isActive: true, isDigitalOrderingEnabled: true },
    });

    const rows: AdminLocationPerformanceRow[] = allLocations
      .filter(
        (location) => location.isActive || totalsByLocation.has(location.id),
      )
      .map((location) => {
        const totals = totalsByLocation.get(location.id) ?? {
          totalOrders: 0,
          completedOrders: 0,
          digitalSalesMinorUnits: 0,
        };
        return {
          locationId: location.id,
          locationName: location.name,
          isActive: location.isActive,
          isDigitalOrderingEnabled: location.isDigitalOrderingEnabled,
          totalOrders: totals.totalOrders,
          completedOrders: totals.completedOrders,
          completedPercent: completedPercent(
            totals.completedOrders,
            totals.totalOrders,
          ),
          digitalSalesMinorUnits: totals.digitalSalesMinorUnits,
          averageOrderValueMinorUnits:
            totals.totalOrders === 0
              ? 0
              : Math.round(
                  totals.digitalSalesMinorUnits / totals.totalOrders,
                ),
        };
      })
      .sort(
        (a, b) =>
          a.locationName.localeCompare(b.locationName) ||
          (a.locationId < b.locationId ? -1 : a.locationId > b.locationId ? 1 : 0),
      );

    return {
      filters: { startDate, endDate },
      locations: rows,
      source: {
        scope: 'DIGITAL_PLATFORM_ONLY',
        scopeLabel:
          'Digital-platform orders only. In-store/POS transactions are not included.',
        freshnessLabel: 'Live platform data',
      },
    };
  }
}

// completedOrders / totalOrders * 100, rounded to one decimal place using
// integer-scaled rounding (Math.round on a *1000 numerator, then /10) so
// the result is deterministic and never subject to floating-point
// display ambiguity — e.g. 1/3 -> 33.3, 2/3 -> 66.7, 1/6 -> 16.7. 0 when
// totalOrders is 0 (never NaN/Infinity from a 0/0 division). Exported for
// direct unit testing of the rounding rule.
export function completedPercent(completedOrders: number, totalOrders: number): number {
  if (totalOrders === 0) {
    return 0;
  }
  return Math.round((completedOrders * 1000) / totalOrders) / 10;
}
