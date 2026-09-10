import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { RedisModule } from '../redis/redis.module';
import { AdminCareersController } from './api/admin-careers.controller';
import { AdminCareersApplicationsController } from './api/admin-careers-applications.controller';
import { CareersController } from './api/careers.controller';
import { JobOpeningsAdminService } from './application/job-openings-admin.service';
import { JobOpeningsPublicService } from './application/job-openings-public.service';
import { JobApplicationsPublicService } from './application/job-applications-public.service';
import { JobApplicationsAdminService } from './application/job-applications-admin.service';
import { JobApplicationNotesService } from './application/job-application-notes.service';
import { CareersPublicThrottleGuard } from './infrastructure/careers-public-throttle.guard';

// Milestone 8B — Careers / Job Openings. HQ manages openings (Admin →
// Careers, careers.view / careers.manage, CORPORATE-only); the public site
// lists and shows PUBLISHED + visible ones. The ONLY new table is
// JobOpening; the Location domain is reused via a plain relation. Applicant
// submission / management is Milestone 8C and is not here.
//
// InternalAuthGuard / PermissionGuard / AuthorizationService come from the
// @Global InternalAuthModule; PrismaService from the @Global PrismaModule;
// InternalAuditService from AuditModule (create / update / status changes
// are audited in the same transaction).
@Module({
  imports: [PrismaModule, AuditModule, RedisModule],
  controllers: [
    AdminCareersController,
    AdminCareersApplicationsController,
    CareersController,
  ],
  providers: [
    JobOpeningsAdminService,
    JobOpeningsPublicService,
    JobApplicationsPublicService,
    JobApplicationsAdminService,
    JobApplicationNotesService,
    CareersPublicThrottleGuard,
  ],
})
export class CareersModule {}
