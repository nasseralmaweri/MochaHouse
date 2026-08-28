import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  LocationSummary,
  ReorderIssue,
  ReorderPreparation,
} from '@mocha-house/contracts';
import {
  prepareReorder,
  type HistoricalReorderLine,
  type HistoricalReorderSelection,
} from '@mocha-house/domain';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationsService } from '../../locations/application/locations.service';

// Milestone 4G — prepares (never places) a reorder. Reads a
// customer-owned historical Order and revalidates its immutable line
// snapshots against the CURRENT location/menu/catalog state via the pure
// domain function. This service:
//   - never creates an Order, PaymentAttempt, OutboxEvent
//   - never mutates the historical Order, the menu, or customer data
//   - resolves ownership inside the database query (id + customerId), so a
//     non-owned order is indistinguishable from a missing one (404)
//
// Any Order row is eligible regardless of fulfillment status: an Order is
// only ever created inside CheckoutService's post-payment transaction, so
// every row is a legitimately paid, customer-requested order with durable
// snapshots. There is no CANCELLED/failed Order state to exclude — failed
// or declined payments never produce an Order at all.
@Injectable()
export class CustomerReorderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locationsService: LocationsService,
  ) {}

  async prepare(
    customerId: string,
    orderId: string,
  ): Promise<ReorderPreparation> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId },
      include: { location: true, lines: true },
    });

    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    const location: LocationSummary = {
      id: order.location.id,
      name: order.location.name,
      slug: order.location.slug,
      isDigitalOrderingEnabled: order.location.isDigitalOrderingEnabled,
    };

    // findMenu returns null when the location or its active menu no longer
    // exists / is inactive. It does NOT filter on digital ordering — that
    // check is ours to make (a location can be a real, active location
    // that is simply not taking online orders right now).
    const menu = await this.locationsService.findMenu(order.locationId);

    if (!menu) {
      return this.locationUnavailable(order, location, {
        code: 'LOCATION_INACTIVE',
        message: "This location isn't available for online ordering right now.",
      });
    }

    if (!menu.location.isDigitalOrderingEnabled) {
      return this.locationUnavailable(order, location, {
        code: 'LOCATION_DIGITAL_ORDERING_DISABLED',
        message: "This location isn't accepting online orders right now.",
      });
    }

    const historicalLines: HistoricalReorderLine[] = order.lines.map(
      (line) => ({
        productId: line.productId,
        productName: line.productName,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        currency: line.currency,
        selections: parseSelections(line.selections),
      }),
    );

    const prepared = prepareReorder(menu, historicalLines);

    return {
      orderId: order.id,
      location,
      menuId: menu.menu.id,
      status: prepared.status,
      items: prepared.items,
      issues: [],
      historicalTotal: order.subtotal,
      currentEstimatedSubtotal: prepared.currentEstimatedSubtotal,
    };
  }

  private locationUnavailable(
    order: { id: string; subtotal: number },
    location: LocationSummary,
    issue: ReorderIssue,
  ): ReorderPreparation {
    return {
      orderId: order.id,
      location,
      status: 'UNAVAILABLE',
      items: [],
      issues: [issue],
      historicalTotal: order.subtotal,
      currentEstimatedSubtotal: 0,
    };
  }
}

// OrderLine.selections is stored from priceCart's selectionSnapshots (see
// CheckoutService.createOrderTransactionally), which always includes the
// stable groupId / optionIds. Read defensively anyway — this is a Json
// column.
function parseSelections(
  value: Prisma.JsonValue,
): HistoricalReorderSelection[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const selections: HistoricalReorderSelection[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const groupId = typeof record.groupId === 'string' ? record.groupId : null;
    if (!groupId) {
      continue;
    }
    const optionIds = Array.isArray(record.optionIds)
      ? record.optionIds.filter((id): id is string => typeof id === 'string')
      : [];
    const optionNames = Array.isArray(record.optionNames)
      ? record.optionNames.filter((n): n is string => typeof n === 'string')
      : [];
    selections.push({
      groupId,
      groupName:
        typeof record.groupName === 'string' ? record.groupName : 'Options',
      optionIds,
      optionNames,
    });
  }
  return selections;
}
