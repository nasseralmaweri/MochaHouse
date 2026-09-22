import { Injectable } from '@nestjs/common';
import type {
  AdminOperationsChecklistReport,
  AdminOperationsChecklistRow,
} from '@mocha-house/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthorizationContext } from '../internal-auth/authorization/authorization-context';
import { businessDateToStorage } from '../operations/application/business-date';
import {
  CLOSING_TEMPLATE_KEY,
  OPENING_TEMPLATE_KEY,
} from '../operations/application/checklist-execution.service';
import { requireReportDateRange } from './report-date-range';

export interface OperationsChecklistQuery {
  startDate?: string;
  endDate?: string;
}

interface LocationTotals {
  openingStarted: number;
  openingCompleted: number;
  openingCurrentExceptions: number;
  closingStarted: number;
  closingCompleted: number;
  closingCurrentExceptions: number;
}

function emptyTotals(): LocationTotals {
  return {
    openingStarted: 0,
    openingCompleted: 0,
    openingCurrentExceptions: 0,
    closingStarted: 0,
    closingCompleted: 0,
    closingCurrentExceptions: 0,
  };
}

// Milestone 9C — HQ Operations Checklist Visibility. Read-only. This is
// OPERATIONS VISIBILITY, not compliance scoring — see the extended comment
// on AdminOperationsChecklistReport in @mocha-house/contracts for the full
// rationale. Two load-bearing facts drive every decision in this service:
//
//   1. A ChecklistInstance is created LAZILY, only on the first GET of a
//      location's checklist for a business day. Zero instances for a
//      location/period means "no recorded activity," never "missed."
//   2. ChecklistInstanceItem.exceptionAt reflects CURRENT state only — a
//      logged-then-cleared exception reverts to null and is not counted
//      here. "Current Exceptions" is a live-state count, not a historical
//      log (the full history exists only in InternalAuditEvent, which this
//      service deliberately does not query, per the approved 9C scope).
@Injectable()
export class OperationsChecklistReportService {
  constructor(private readonly prisma: PrismaService) {}

  async getOperationsChecklistReport(
    query: OperationsChecklistQuery,
    authorization: AuthorizationContext,
  ): Promise<AdminOperationsChecklistReport> {
    // `reports.view` is CORPORATE-only in the permission catalog, so
    // PermissionGuard already rejects a LOCATION grant; this is the
    // matching service-layer defense (same pattern as 9A/9B).
    authorization.assertCorporate('reports.view');

    const { startDate, endDate } = requireReportDateRange(
      query.startDate,
      query.endDate,
    );

    // ChecklistInstance.businessDate is a stored `@db.Date` value, resolved
    // once at instance creation — never reconstructed from createdAt, and
    // never converted through the Order-report instant-range logic (9A/9B
    // filter a real DateTime; this filters an already-calendar-date
    // column). The comparison is a simple inclusive range.
    const rangeStart = businessDateToStorage(startDate);
    const rangeEnd = businessDateToStorage(endDate);

    const templates = await this.prisma.checklistTemplate.findMany({
      where: { key: { in: [OPENING_TEMPLATE_KEY, CLOSING_TEMPLATE_KEY] } },
      select: { id: true, key: true },
    });
    const openingTemplateId =
      templates.find((t) => t.key === OPENING_TEMPLATE_KEY)?.id ?? null;
    const closingTemplateId =
      templates.find((t) => t.key === CLOSING_TEMPLATE_KEY)?.id ?? null;
    const templateIds = [openingTemplateId, closingTemplateId].filter(
      (id): id is string => id !== null,
    );

    const [started, completed, exceptionedItems, allLocations] =
      await Promise.all([
        this.prisma.checklistInstance.groupBy({
          by: ['locationId', 'templateId'],
          where: {
            templateId: { in: templateIds },
            businessDate: { gte: rangeStart, lte: rangeEnd },
          },
          _count: { _all: true },
        }),
        this.prisma.checklistInstance.groupBy({
          by: ['locationId', 'templateId'],
          where: {
            templateId: { in: templateIds },
            businessDate: { gte: rangeStart, lte: rangeEnd },
            completedAt: { not: null },
          },
          _count: { _all: true },
        }),
        // Exceptioned items are a small subset of all items — a bounded
        // findMany + in-memory count, never a fetch of every checklist item.
        this.prisma.checklistInstanceItem.findMany({
          where: {
            exceptionAt: { not: null },
            checklistInstance: {
              templateId: { in: templateIds },
              businessDate: { gte: rangeStart, lte: rangeEnd },
            },
          },
          select: {
            checklistInstance: {
              select: { locationId: true, templateId: true },
            },
          },
        }),
        this.prisma.location.findMany({
          select: { id: true, name: true, isActive: true },
        }),
      ]);

    const totalsByLocation = new Map<string, LocationTotals>();
    const totalsFor = (locationId: string): LocationTotals => {
      let totals = totalsByLocation.get(locationId);
      if (!totals) {
        totals = emptyTotals();
        totalsByLocation.set(locationId, totals);
      }
      return totals;
    };

    for (const group of started) {
      const totals = totalsFor(group.locationId);
      const count = group._count._all;
      if (group.templateId === openingTemplateId) {
        totals.openingStarted += count;
      } else if (group.templateId === closingTemplateId) {
        totals.closingStarted += count;
      }
    }

    for (const group of completed) {
      const totals = totalsFor(group.locationId);
      const count = group._count._all;
      if (group.templateId === openingTemplateId) {
        totals.openingCompleted += count;
      } else if (group.templateId === closingTemplateId) {
        totals.closingCompleted += count;
      }
    }

    for (const item of exceptionedItems) {
      const totals = totalsFor(item.checklistInstance.locationId);
      if (item.checklistInstance.templateId === openingTemplateId) {
        totals.openingCurrentExceptions += 1;
      } else if (item.checklistInstance.templateId === closingTemplateId) {
        totals.closingCurrentExceptions += 1;
      }
    }

    // The roster, not the checklist activity, drives which locations are
    // shown — identical inclusion rule to 9B, re-derived here because it
    // holds for the same underlying reason: locations are never hard
    // deleted, so historical FK integrity is guaranteed either way.
    const rows: AdminOperationsChecklistRow[] = allLocations
      .filter(
        (location) => location.isActive || totalsByLocation.has(location.id),
      )
      .map((location) => {
        const totals = totalsByLocation.get(location.id) ?? emptyTotals();
        return {
          locationId: location.id,
          locationName: location.name,
          isActive: location.isActive,
          ...totals,
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
        scope: 'INTERNAL_OPERATIONS',
        scopeLabel:
          'Store operations data recorded in the Mocha House platform.',
        freshnessLabel: 'Live platform data',
      },
    };
  }
}
