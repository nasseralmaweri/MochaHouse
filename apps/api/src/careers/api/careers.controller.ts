import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { SubmitJobApplicationRequest } from '@mocha-house/contracts';
import { JobOpeningsPublicService } from '../application/job-openings-public.service';
import { JobApplicationsPublicService } from '../application/job-applications-public.service';
import { CareersPublicThrottleGuard } from '../infrastructure/careers-public-throttle.guard';

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
  ) {}

  @Get('jobs')
  list() {
    return this.jobs.list();
  }

  @Get('jobs/:jobId')
  detail(@Param('jobId') jobId: string) {
    return this.jobs.getDetail(jobId);
  }

  @UseGuards(CareersPublicThrottleGuard)
  @Post('jobs/:jobId/applications')
  apply(
    @Param('jobId') jobId: string,
    @Body() body: SubmitJobApplicationRequest,
  ) {
    return this.applications.submit(jobId, body);
  }
}
