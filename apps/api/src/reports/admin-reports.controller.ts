import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { OrdersOverviewReportService } from './orders-overview.service';
import { LocationPerformanceReportService } from './location-performance.service';
import { OperationsChecklistReportService } from './operations-checklist.service';
import { CustomerGrowthReportService } from './customer-growth.service';
import { buildCsvDocument } from './csv-serializer';
import { buildExportFilename } from './export-filename';
import {
  customerGrowthCsvRows,
  locationPerformanceCsvRows,
  operationsChecklistCsvRows,
  ordersOverviewCsvRows,
} from './report-csv-rows';
import { InternalAuthGuard } from '../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../internal-auth/infrastructure/internal-identity';

// HQ Reporting (Milestone 9A: Digital Sales & Orders; Milestone 9B:
// Location Performance; Milestone 9C: Operations Checklist Visibility;
// Milestone 9D: Customer Growth & Ordering; Milestone 9E: CSV export).
// Read-only.
//
// InternalAuthGuard then PermissionGuard. `reports.view` is CORPORATE-only
// in the permission catalog, so a LOCATION-scoped grant can never satisfy
// `PermissionGuard.has()`; each service also calls `assertCorporate`. There
// is no write route — a report cannot be edited, only viewed or exported.
//
// Every `.../export` route calls the EXACT SAME service method as its
// JSON sibling and maps the identical typed result through a pure CSV
// mapper (report-csv-rows.ts) — there is never a second implementation of
// any metric, and no export-specific authorization, validation or
// database access exists anywhere in this file. `@Res()` + `res.send()`
// follows the same precedent MediaObjectsController already established
// for a non-JSON response in this codebase.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/reports')
export class AdminReportsController {
  constructor(
    private readonly ordersOverview: OrdersOverviewReportService,
    private readonly locationPerformance: LocationPerformanceReportService,
    private readonly operationsChecklist: OperationsChecklistReportService,
    private readonly customerGrowth: CustomerGrowthReportService,
  ) {}

  @RequirePermission('reports.view')
  @Get('orders-overview')
  ordersOverviewReport(
    @Req() request: InternalAuthenticatedRequest,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('locationId') locationId?: string,
  ) {
    return this.ordersOverview.getOrdersOverview(
      { startDate, endDate, locationId },
      request.authorization!,
    );
  }

  @RequirePermission('reports.view')
  @Get('orders-overview/export')
  async ordersOverviewExport(
    @Req() request: InternalAuthenticatedRequest,
    @Res() res: Response,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('locationId') locationId?: string,
  ) {
    const report = await this.ordersOverview.getOrdersOverview(
      { startDate, endDate, locationId },
      request.authorization!,
    );
    sendCsv(
      res,
      buildCsvDocument(ordersOverviewCsvRows(report)),
      buildExportFilename(
        'digital-sales-orders',
        report.filters.startDate,
        report.filters.endDate,
        report.location?.name ?? null,
      ),
    );
  }

  @RequirePermission('reports.view')
  @Get('location-performance')
  locationPerformanceReport(
    @Req() request: InternalAuthenticatedRequest,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.locationPerformance.getLocationPerformance(
      { startDate, endDate },
      request.authorization!,
    );
  }

  @RequirePermission('reports.view')
  @Get('location-performance/export')
  async locationPerformanceExport(
    @Req() request: InternalAuthenticatedRequest,
    @Res() res: Response,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const report = await this.locationPerformance.getLocationPerformance(
      { startDate, endDate },
      request.authorization!,
    );
    sendCsv(
      res,
      buildCsvDocument(locationPerformanceCsvRows(report)),
      buildExportFilename(
        'location-performance',
        report.filters.startDate,
        report.filters.endDate,
      ),
    );
  }

  @RequirePermission('reports.view')
  @Get('operations-checklists')
  operationsChecklistReport(
    @Req() request: InternalAuthenticatedRequest,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.operationsChecklist.getOperationsChecklistReport(
      { startDate, endDate },
      request.authorization!,
    );
  }

  @RequirePermission('reports.view')
  @Get('operations-checklists/export')
  async operationsChecklistExport(
    @Req() request: InternalAuthenticatedRequest,
    @Res() res: Response,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const report = await this.operationsChecklist.getOperationsChecklistReport(
      { startDate, endDate },
      request.authorization!,
    );
    sendCsv(
      res,
      buildCsvDocument(operationsChecklistCsvRows(report)),
      buildExportFilename(
        'operations-checklist-visibility',
        report.filters.startDate,
        report.filters.endDate,
      ),
    );
  }

  @RequirePermission('reports.view')
  @Get('customer-growth')
  customerGrowthReport(
    @Req() request: InternalAuthenticatedRequest,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.customerGrowth.getCustomerGrowthReport(
      { startDate, endDate },
      request.authorization!,
    );
  }

  @RequirePermission('reports.view')
  @Get('customer-growth/export')
  async customerGrowthExport(
    @Req() request: InternalAuthenticatedRequest,
    @Res() res: Response,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const report = await this.customerGrowth.getCustomerGrowthReport(
      { startDate, endDate },
      request.authorization!,
    );
    sendCsv(
      res,
      buildCsvDocument(customerGrowthCsvRows(report)),
      buildExportFilename(
        'customer-growth-ordering',
        report.filters.startDate,
        report.filters.endDate,
      ),
    );
  }
}

function sendCsv(res: Response, csv: Buffer, filename: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}
