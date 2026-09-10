import { Controller, Get, Param } from '@nestjs/common';
import { JobOpeningsPublicService } from '../application/job-openings-public.service';

// The PUBLIC Careers API (Milestone 8B). No authentication. Only
// publicly-visible job openings (PUBLISHED + corporate or active-location)
// are ever returned; a non-visible job is 404 from detail — its existence
// is not revealed. Applicant submission is Milestone 8C.
@Controller('api/v1/careers')
export class CareersController {
  constructor(private readonly service: JobOpeningsPublicService) {}

  @Get('jobs')
  list() {
    return this.service.list();
  }

  @Get('jobs/:jobId')
  detail(@Param('jobId') jobId: string) {
    return this.service.getDetail(jobId);
  }
}
