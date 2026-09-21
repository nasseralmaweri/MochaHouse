import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { OrdersOverviewReportService } from './orders-overview.service';
import { LocationPerformanceReportService } from './location-performance.service';
import { InternalAuthGuard } from '../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../internal-auth/infrastructure/internal-identity';

// HQ Reporting (Milestone 9A: Digital Sales & Orders; Milestone 9B:
// Location Performance). Read-only.
//
// InternalAuthGuard then PermissionGuard. `reports.view` is CORPORATE-only
// in the permission catalog, so a LOCATION-scoped grant can never satisfy
// `PermissionGuard.has()`; each service also calls `assertCorporate`. There
// is no write route — a report cannot be edited, only viewed.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/reports')
export class AdminReportsController {
  constructor(
    private readonly ordersOverview: OrdersOverviewReportService,
    private readonly locationPerformance: LocationPerformanceReportService,
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
}
