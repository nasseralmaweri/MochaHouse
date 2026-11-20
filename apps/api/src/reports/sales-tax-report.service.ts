import { BadRequestException, Injectable } from '@nestjs/common';
import {
  formatTaxRatePpm,
  type SalesTaxReportComponent,
  type SalesTaxReportLocation,
  type SalesTaxReportRefund,
  type SalesTaxReportResponse,
  type TaxJurisdiction,
} from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthorizationContext } from '../internal-auth/authorization/authorization-context';
import {
  businessDateRangeToUtcInstants,
  MOCHA_HOUSE_TIME_ZONE,
} from '../operations/application/business-date';
import { requireReportDateRange } from './report-date-range';
import {
  obligationStanding,
  type PaymentRefundStatus,
  type RefundRow,
} from '../payment/payment-refunds';
import { itemTaxRefundStatus } from '../tax/application/tax-refunds';

// V1 Sales Tax PR 3 — the sales tax report (reports.view, corporate). Only
// orders taxed at checkout have a tax snapshot; orders from before sales tax
// are not included (nothing is retroactive).
//   * Sales and tax collected: by the order's date.
//   * Tax refunded: by the tax refund record's date, CONFIRMED only — an
//     item refund whose card refund succeeded; a cancellation once its card
//     money is refunded (or at once when none was card-paid). Pending and
//     failed are shown apart and never counted.
//   * Unattributed: amount-only refunds of taxed orders (and cancellations
//     whose lines could not be matched). Their tax is unknown and never
//     assumed: while any exist in the period, every net tax is null.

export interface SalesTaxReportQuery {
  startDate?: string;
  endDate?: string;
  locationId?: string;
}

const NOT_REFUNDED: readonly PaymentRefundStatus[] = [
  'FAILED',
  'CANCELED',
  'NOT_CREATED',
  'FAILED_AFTER_SUCCESS',
];
const ROW_LIMIT = 500;

interface DetailComponent {
  componentId: string;
  name: string;
  jurisdiction: string;
  ratePpm: number;
  taxClassIds: string[];
  taxableMinorUnits: number;
  taxMinorUnits: number;
}
interface DetailLine {
  taxClassId: string;
  taxableMinorUnits: number;
}

interface Bucket {
  orders: number;
  netSales: number;
  taxableSales: number;
  collected: number;
  refunded: number;
  components: Map<
    string,
    {
      name: string;
      jurisdiction: string;
      ratePpm: number;
      taxable: number;
      collected: number;
      refunded: number;
    }
  >;
}

const componentKeyOf = (c: {
  name: string;
  jurisdiction: string;
  ratePpm: number;
}) => `${c.jurisdiction}|${c.ratePpm}|${c.name}`;

const newBucket = (): Bucket => ({
  orders: 0,
  netSales: 0,
  taxableSales: 0,
  collected: 0,
  refunded: 0,
  components: new Map(),
});

@Injectable()
export class SalesTaxReportService {
  constructor(private readonly prisma: PrismaService) {}

  async getReport(
    query: SalesTaxReportQuery,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<SalesTaxReportResponse> {
    authorization.assertCorporate('reports.view');
    const tenantId = tenant.tenantId;
    const { startDate, endDate } = requireReportDateRange(
      query.startDate,
      query.endDate,
    );
    const locationId =
      typeof query.locationId === 'string' && query.locationId.trim()
        ? query.locationId.trim()
        : null;
    const locations = await this.prisma.location.findMany({
      where: { tenantId },
      select: { id: true, name: true },
    });
    if (locationId && !locations.some((l) => l.id === locationId)) {
      // Another business's location reads exactly like an unknown one.
      throw new BadRequestException('Unknown location.');
    }
    const locationName = new Map(locations.map((l) => [l.id, l.name]));
    const { start, endExclusive } = businessDateRangeToUtcInstants(
      startDate,
      endDate,
      MOCHA_HOUSE_TIME_ZONE,
    );
    const inRange = { gte: start, lt: endExclusive };
    const atLocation = locationId ? { locationId } : {};

    const [snapshots, taxRefunds, amountOnly, unmatchedClosures] =
      await Promise.all([
        this.prisma.orderTaxSnapshot.findMany({
          where: { tenantId, createdAt: inRange, order: atLocation },
          select: {
            currency: true,
            merchandiseSubtotal: true,
            discountMinorUnits: true,
            taxMinorUnits: true,
            detail: true,
            order: { select: { locationId: true } },
          },
        }),
        this.prisma.orderTaxRefund.findMany({
          where: { tenantId, createdAt: inRange, ...atLocation },
          orderBy: { createdAt: 'asc' },
          select: {
            kind: true,
            locationId: true,
            merchandiseMinorUnits: true,
            taxMinorUnits: true,
            createdAt: true,
            order: {
              select: { id: true, orderNumber: true, paymentAttemptId: true },
            },
            paymentRefund: {
              select: { status: true, amountMinorUnits: true },
            },
            orderClosure: {
              select: {
                refundDueMinorUnits: true,
                refundObligation: {
                  select: { amountMinorUnits: true, status: true },
                },
              },
            },
            components: {
              select: {
                name: true,
                jurisdiction: true,
                ratePpm: true,
                taxMinorUnits: true,
              },
            },
          },
        }),
        // Amount-only refunds of taxed, not cancelled orders.
        this.prisma.paymentRefund.findMany({
          where: {
            tenantId,
            createdAt: inRange,
            status: { notIn: [...NOT_REFUNDED] },
            taxRefund: null,
            order: {
              ...atLocation,
              closure: null,
              taxSnapshot: { taxMinorUnits: { gt: 0 } },
            },
          },
          orderBy: { createdAt: 'asc' },
          select: {
            amountMinorUnits: true,
            createdAt: true,
            order: {
              select: { id: true, orderNumber: true, locationId: true },
            },
          },
        }),
        // Cancellations of taxed orders without a tax record (lines that
        // could not be matched): their tax is unresolved.
        this.prisma.orderClosure.findMany({
          where: {
            tenantId,
            createdAt: inRange,
            taxRefund: null,
            order: { ...atLocation, taxSnapshot: { taxMinorUnits: { gt: 0 } } },
          },
          select: {
            createdAt: true,
            refundDueMinorUnits: true,
            order: {
              select: { id: true, orderNumber: true, locationId: true },
            },
          },
        }),
      ]);

    // The card refunds of the cancelled orders above (for their standing).
    const closureAttempts = taxRefunds
      .filter((r) => r.kind === 'CLOSURE' && r.orderClosure?.refundObligation)
      .map((r) => r.order.paymentAttemptId);
    const closureRefunds = closureAttempts.length
      ? await this.prisma.paymentRefund.findMany({
          where: { tenantId, paymentAttemptId: { in: closureAttempts } },
          select: {
            paymentAttemptId: true,
            status: true,
            amountMinorUnits: true,
            origin: true,
            succeededAt: true,
            lateFailureReviewedAt: true,
          },
        })
      : [];
    const refundRowsOf = (attemptId: string): RefundRow[] =>
      closureRefunds
        .filter((r) => r.paymentAttemptId === attemptId)
        .map((r) => ({
          status: r.status as PaymentRefundStatus,
          amountMinorUnits: r.amountMinorUnits,
          origin: r.origin === 'EXTERNAL' ? 'EXTERNAL' : 'CENTERIVO',
          succeededAt: r.succeededAt,
          lateFailureReviewedAt: r.lateFailureReviewedAt,
        }));

    const buckets = new Map<string, Bucket>();
    const bucketOf = (id: string) => {
      let b = buckets.get(id);
      if (!b) {
        b = newBucket();
        buckets.set(id, b);
      }
      return b;
    };
    let currency = 'USD';

    for (const s of snapshots) {
      currency = s.currency;
      const b = bucketOf(s.order.locationId);
      const detail = s.detail as unknown as {
        components?: DetailComponent[];
        lines?: DetailLine[];
      };
      const covered = new Set(
        (detail.components ?? []).flatMap((c) => c.taxClassIds),
      );
      b.orders += 1;
      b.netSales += s.merchandiseSubtotal - s.discountMinorUnits;
      b.taxableSales += (detail.lines ?? [])
        .filter((l) => covered.has(l.taxClassId))
        .reduce((sum, l) => sum + l.taxableMinorUnits, 0);
      b.collected += s.taxMinorUnits;
      for (const c of detail.components ?? []) {
        const key = componentKeyOf(c);
        const entry = b.components.get(key) ?? {
          name: c.name,
          jurisdiction: c.jurisdiction,
          ratePpm: c.ratePpm,
          taxable: 0,
          collected: 0,
          refunded: 0,
        };
        entry.taxable += c.taxableMinorUnits;
        entry.collected += c.taxMinorUnits;
        b.components.set(key, entry);
      }
    }

    const rows: SalesTaxReportRefund[] = [];
    let pending = 0;
    let failed = 0;
    for (const r of taxRefunds) {
      let status: 'CONFIRMED' | 'PENDING' | 'FAILED';
      if (r.kind === 'ITEM') {
        status = itemTaxRefundStatus(r.paymentRefund?.status ?? 'FAILED');
      } else {
        const obligation = r.orderClosure?.refundObligation ?? null;
        if (!obligation) {
          status = 'CONFIRMED';
        } else {
          const standing = obligationStanding(
            obligation.amountMinorUnits,
            refundRowsOf(r.order.paymentAttemptId),
            obligation.status,
          );
          status =
            !standing.needsAttention &&
            (standing.fullyRefunded || obligation.status === 'REFUNDED')
              ? 'CONFIRMED'
              : 'PENDING';
        }
      }
      if (status === 'CONFIRMED') {
        const b = bucketOf(r.locationId);
        b.refunded += r.taxMinorUnits;
        for (const c of r.components) {
          const key = componentKeyOf(c);
          const entry = b.components.get(key) ?? {
            name: c.name,
            jurisdiction: c.jurisdiction,
            ratePpm: c.ratePpm,
            taxable: 0,
            collected: 0,
            refunded: 0,
          };
          entry.refunded += c.taxMinorUnits;
          b.components.set(key, entry);
        }
      } else if (status === 'PENDING') {
        pending += r.taxMinorUnits;
      } else {
        failed += r.taxMinorUnits;
      }
      rows.push({
        orderId: r.order.id,
        orderNumber: r.order.orderNumber,
        locationName: locationName.get(r.locationId) ?? '',
        kind: r.kind === 'ITEM' ? 'ITEM' : 'CANCELLATION',
        amountMinorUnits:
          r.kind === 'ITEM'
            ? (r.paymentRefund?.amountMinorUnits ?? 0)
            : r.merchandiseMinorUnits + r.taxMinorUnits,
        taxMinorUnits: r.taxMinorUnits,
        status,
        date: r.createdAt.toISOString(),
      });
    }

    const unresolved = [
      ...amountOnly.map((r) => ({
        orderId: r.order.id,
        orderNumber: r.order.orderNumber,
        locationId: r.order.locationId,
        amount: r.amountMinorUnits,
        kind: 'UNATTRIBUTED' as const,
        date: r.createdAt,
      })),
      ...unmatchedClosures.map((c) => ({
        orderId: c.order.id,
        orderNumber: c.order.orderNumber,
        locationId: c.order.locationId,
        amount: c.refundDueMinorUnits,
        kind: 'CANCELLATION' as const,
        date: c.createdAt,
      })),
    ];
    for (const u of unresolved) {
      rows.push({
        orderId: u.orderId,
        orderNumber: u.orderNumber,
        locationName: locationName.get(u.locationId) ?? '',
        kind: u.kind,
        amountMinorUnits: u.amount,
        taxMinorUnits: null,
        status: 'UNRESOLVED',
        date: u.date.toISOString(),
      });
    }
    const unresolvedAt = new Set(unresolved.map((u) => u.locationId));
    const anyUnresolved = unresolved.length > 0;

    const componentsOf = (
      maps: Bucket['components'][],
      unresolvedHere: boolean,
    ): SalesTaxReportComponent[] => {
      const merged = new Map<
        string,
        {
          name: string;
          jurisdiction: string;
          ratePpm: number;
          taxable: number;
          collected: number;
          refunded: number;
        }
      >();
      for (const m of maps) {
        for (const [key, c] of m) {
          const e = merged.get(key) ?? {
            ...c,
            taxable: 0,
            collected: 0,
            refunded: 0,
          };
          e.taxable += c.taxable;
          e.collected += c.collected;
          e.refunded += c.refunded;
          merged.set(key, e);
        }
      }
      return [...merged.values()]
        .sort(
          (a, b) =>
            a.jurisdiction.localeCompare(b.jurisdiction) ||
            b.ratePpm - a.ratePpm ||
            a.name.localeCompare(b.name),
        )
        .map((c) => ({
          name: c.name,
          jurisdiction: c.jurisdiction as TaxJurisdiction,
          ratePercent: formatTaxRatePpm(c.ratePpm),
          taxableSalesMinorUnits: c.taxable,
          taxCollectedMinorUnits: c.collected,
          taxRefundedMinorUnits: c.refunded,
          netTaxMinorUnits: unresolvedHere ? null : c.collected - c.refunded,
        }));
    };

    const locationRows: SalesTaxReportLocation[] = [...buckets.entries()]
      .map(([id, b]) => ({
        locationId: id,
        locationName: locationName.get(id) ?? '',
        orders: b.orders,
        netSalesMinorUnits: b.netSales,
        taxableSalesMinorUnits: b.taxableSales,
        exemptSalesMinorUnits: b.netSales - b.taxableSales,
        taxCollectedMinorUnits: b.collected,
        taxRefundedMinorUnits: b.refunded,
        netTaxMinorUnits: unresolvedAt.has(id)
          ? null
          : b.collected - b.refunded,
        components: componentsOf([b.components], unresolvedAt.has(id)),
      }))
      .sort((a, b) => a.locationName.localeCompare(b.locationName));

    const sum = (f: (l: SalesTaxReportLocation) => number) =>
      locationRows.reduce((a, l) => a + f(l), 0);
    const collected = sum((l) => l.taxCollectedMinorUnits);
    const refunded = sum((l) => l.taxRefundedMinorUnits);

    return {
      from: startDate,
      to: endDate,
      timeZone: MOCHA_HOUSE_TIME_ZONE,
      currency,
      locationId,
      availableLocations: [...locations].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      totals: {
        orders: sum((l) => l.orders),
        netSalesMinorUnits: sum((l) => l.netSalesMinorUnits),
        taxableSalesMinorUnits: sum((l) => l.taxableSalesMinorUnits),
        exemptSalesMinorUnits: sum((l) => l.exemptSalesMinorUnits),
        taxCollectedMinorUnits: collected,
        taxRefundedMinorUnits: refunded,
        netTaxMinorUnits: anyUnresolved ? null : collected - refunded,
      },
      components: componentsOf(
        [...buckets.values()].map((b) => b.components),
        anyUnresolved,
      ),
      locations: locationRows,
      pendingTaxRefundMinorUnits: pending,
      failedTaxRefundMinorUnits: failed,
      unattributedRefunds: unresolved.length,
      unattributedRefundMinorUnits: unresolved.reduce(
        (a, u) => a + u.amount,
        0,
      ),
      refunds: rows
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, ROW_LIMIT),
    };
  }
}
