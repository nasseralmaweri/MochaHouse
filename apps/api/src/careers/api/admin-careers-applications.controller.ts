import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  CreateJobApplicationNoteRequest,
  UpdateJobApplicationStatusRequest,
} from '@mocha-house/contracts';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { JobApplicationsAdminService } from '../application/job-applications-admin.service';
import { JobApplicationNotesService } from '../application/job-application-notes.service';

// Admin → Careers → Applicants (Milestone 8C). InternalAuthGuard then
// PermissionGuard.
//   applicants.view    — list / detail / notes list.
//   applicants.manage  — change status / add a note.
// Both CORPORATE-only (candidate PII); every service method also calls
// assertCorporate. There is NO general application PATCH — status moves
// only through the dedicated action.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/careers/applications')
export class AdminCareersApplicationsController {
  constructor(
    private readonly service: JobApplicationsAdminService,
    private readonly notes: JobApplicationNotesService,
  ) {}

  @RequirePermission('applicants.view')
  @Get()
  list(
    @Req() request: InternalAuthenticatedRequest,
    @Query('status') status?: string,
    @Query('jobOpeningId') jobOpeningId?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.list(
      { status, jobOpeningId, cursor },
      request.authorization!,
    );
  }

  @RequirePermission('applicants.view')
  @Get(':applicationId')
  detail(
    @Param('applicationId') applicationId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.getDetail(applicationId, request.authorization!);
  }

  @RequirePermission('applicants.manage')
  @Post(':applicationId/status')
  updateStatus(
    @Param('applicationId') applicationId: string,
    @Body() body: UpdateJobApplicationStatusRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.updateStatus(
      applicationId,
      body?.status,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('applicants.view')
  @Get(':applicationId/notes')
  listNotes(
    @Param('applicationId') applicationId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.notes.listForApplication(
      applicationId,
      request.authorization!,
    );
  }

  @RequirePermission('applicants.manage')
  @Post(':applicationId/notes')
  addNote(
    @Param('applicationId') applicationId: string,
    @Body() body: CreateJobApplicationNoteRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.notes.addNote(
      applicationId,
      body?.body,
      request.internalUser!.id,
      request.authorization!,
    );
  }
}
