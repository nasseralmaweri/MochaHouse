import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  CreateJobOpeningRequest,
  UpdateJobOpeningRequest,
} from '@mocha-house/contracts';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { JobOpeningsAdminService } from '../application/job-openings-admin.service';

// Admin → Careers → Jobs (Milestone 8B). InternalAuthGuard (authentication +
// ACTIVE lifecycle) then PermissionGuard.
//   careers.view    — list / options / detail.
//   careers.manage  — create / edit / publish / unpublish / archive.
// Both CORPORATE-only in the catalog; every service method also calls
// assertCorporate. Status changes only through the explicit publish /
// unpublish / archive actions — PATCH never touches status.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/careers/jobs')
export class AdminCareersController {
  constructor(private readonly service: JobOpeningsAdminService) {}

  @RequirePermission('careers.view')
  @Get()
  list(
    @Req() request: InternalAuthenticatedRequest,
    @Query('status') status?: string,
  ) {
    return this.service.list(status, request.authorization!);
  }

  @RequirePermission('careers.view')
  @Get('options')
  options(@Req() request: InternalAuthenticatedRequest) {
    return this.service.getOptions(request.authorization!);
  }

  @RequirePermission('careers.view')
  @Get(':jobId')
  detail(
    @Param('jobId') jobId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.getDetail(jobId, request.authorization!);
  }

  @RequirePermission('careers.manage')
  @Post()
  create(
    @Body() body: CreateJobOpeningRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.create(
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('careers.manage')
  @Patch(':jobId')
  update(
    @Param('jobId') jobId: string,
    @Body() body: UpdateJobOpeningRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.update(
      jobId,
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('careers.manage')
  @Post(':jobId/publish')
  publish(
    @Param('jobId') jobId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.publish(
      jobId,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('careers.manage')
  @Post(':jobId/unpublish')
  unpublish(
    @Param('jobId') jobId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.unpublish(
      jobId,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('careers.manage')
  @Post(':jobId/archive')
  archive(
    @Param('jobId') jobId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.archive(
      jobId,
      request.internalUser!.id,
      request.authorization!,
    );
  }
}
