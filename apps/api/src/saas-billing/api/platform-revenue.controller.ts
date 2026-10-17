import { Controller, Get, Header, Query, Req, UseGuards } from '@nestjs/common';
import type { PlatformRevenueReport } from '@mocha-house/contracts';
import { PlatformAuthGuard } from '../../platform-auth/infrastructure/platform-auth.guard';
import { RequirePlatformPermission } from '../../platform-auth/authorization/platform-permission.guard';
import type { PlatformAuthenticatedRequest } from '../../platform-auth/infrastructure/platform-identity';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { RevenueReportingService } from '../application/revenue-reporting.service';

// SC3f (owner decision D5) — CENTERIVO-wide SaaS revenue reporting, only for
// platform operators holding billing.reports.view (re-read on every
// request; never business staff). Read-only, rate limited (each report is
// computed) and audited.
@UseGuards(PlatformAuthGuard)
@Controller('api/v1/platform/billing/reports')
export class PlatformRevenueController {
  constructor(private readonly reports: RevenueReportingService) {}

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @RequirePlatformPermission('billing.reports.view')
  @Get('revenue')
  revenue(
    @Query('from') from: unknown,
    @Query('to') to: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformRevenueReport> {
    return this.reports.report(
      { from, to },
      request.platformOperator!,
      request.requestId,
    );
  }
}
