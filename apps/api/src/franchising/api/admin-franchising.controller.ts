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
  CreateFranchiseInquiryNoteRequest,
  UpdateFranchiseInquiryStatusRequest,
} from '@mocha-house/contracts';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { FranchiseInquiriesAdminService } from '../application/franchise-inquiries-admin.service';
import { FranchiseInquiryNotesService } from '../application/franchise-inquiry-notes.service';

// Admin → Franchising → Inquiries (Milestone 8D). InternalAuthGuard then
// PermissionGuard.
//   franchising.view    — list / detail / notes list.
//   franchising.manage  — change status / add a note.
// Both CORPORATE-only (prospect PII); every service method also calls
// assertCorporate. There is NO general inquiry PATCH — status moves only
// through the dedicated action.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/franchising/inquiries')
export class AdminFranchisingController {
  constructor(
    private readonly service: FranchiseInquiriesAdminService,
    private readonly notes: FranchiseInquiryNotesService,
  ) {}

  @RequirePermission('franchising.view')
  @Get()
  list(
    @Req() request: InternalAuthenticatedRequest,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.list({ status, cursor }, request.authorization!);
  }

  @RequirePermission('franchising.view')
  @Get(':inquiryId')
  detail(
    @Param('inquiryId') inquiryId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.getDetail(inquiryId, request.authorization!);
  }

  @RequirePermission('franchising.manage')
  @Post(':inquiryId/status')
  updateStatus(
    @Param('inquiryId') inquiryId: string,
    @Body() body: UpdateFranchiseInquiryStatusRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.updateStatus(
      inquiryId,
      body?.status,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('franchising.view')
  @Get(':inquiryId/notes')
  listNotes(
    @Param('inquiryId') inquiryId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.notes.listForInquiry(inquiryId, request.authorization!);
  }

  @RequirePermission('franchising.manage')
  @Post(':inquiryId/notes')
  addNote(
    @Param('inquiryId') inquiryId: string,
    @Body() body: CreateFranchiseInquiryNoteRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.notes.addNote(
      inquiryId,
      body?.body,
      request.internalUser!.id,
      request.authorization!,
    );
  }
}
