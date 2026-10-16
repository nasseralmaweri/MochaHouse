import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { SubmitJobApplicationRequest } from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';
import { JobOpeningsPublicService } from '../application/job-openings-public.service';
import { JobApplicationsPublicService } from '../application/job-applications-public.service';
import { CareersPublicThrottleGuard } from '../infrastructure/careers-public-throttle.guard';
import { StorefrontFeaturesService } from '../../subscriptions/application/storefront-features.service';

// The PUBLIC Careers API. No authentication.
//   GET  /api/v1/careers/jobs              — published + visible openings.
//   GET  /api/v1/careers/jobs/:jobId       — one published + visible opening.
//   POST /api/v1/careers/jobs/:jobId/applications — apply (Milestone 8C).
// Only publicly-visible jobs are ever reachable; a non-visible job is 404.
// The apply route carries a minimal ~5/min/IP Redis throttle
// (CareersPublicThrottleGuard, fail-open). There is NO public GET for
// applications and no id is returned on submit.
@Controller('api/v1/careers')
export class CareersController {
  constructor(
    private readonly jobs: JobOpeningsPublicService,
    private readonly applications: JobApplicationsPublicService,
    private readonly features: StorefrontFeaturesService,
  ) {}

  @Get('jobs')
  // SC2b — without the careers module, openings are not found (404) and a
  // new application is refused (403) before anything is stored or queued.
  async list(@CurrentTenantContext() tenant: TenantContext) {
    await this.features.assertPageAvailable(tenant.tenantId, 'careers');
    return this.jobs.list(tenant);
  }

  @Get('jobs/:jobId')
  async detail(
    @Param('jobId') jobId: string,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    await this.features.assertPageAvailable(tenant.tenantId, 'careers');
    return this.jobs.getDetail(jobId, tenant);
  }

  @UseGuards(CareersPublicThrottleGuard)
  @Post('jobs/:jobId/applications')
  async apply(
    @Param('jobId') jobId: string,
    @Body() body: SubmitJobApplicationRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    await this.features.assertAvailable(tenant.tenantId, 'careers');
    return this.applications.submit(jobId, body, tenant);
  }
}
