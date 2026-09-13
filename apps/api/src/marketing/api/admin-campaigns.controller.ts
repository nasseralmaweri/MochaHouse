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
  CreateCampaignRequest,
  UpdateCampaignRequest,
  UpdateCampaignStatusRequest,
} from '@mocha-house/contracts';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { CampaignsAdminService } from '../application/campaigns-admin.service';

// Admin → Marketing (Milestone 8G). InternalAuthGuard then PermissionGuard.
//   marketing.view    — list / detail / options (read).
//   marketing.manage  — create, edit, and change status.
// Both CORPORATE-only; every service method also calls assertCorporate.
// There is no general status write through PATCH — status moves only
// through the dedicated action.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/marketing/campaigns')
export class AdminCampaignsController {
  constructor(private readonly service: CampaignsAdminService) {}

  @RequirePermission('marketing.view')
  @Get()
  list(
    @Req() request: InternalAuthenticatedRequest,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.list({ status, cursor }, request.authorization!);
  }

  @RequirePermission('marketing.view')
  @Get('options')
  options(@Req() request: InternalAuthenticatedRequest) {
    return this.service.getOptions(request.authorization!);
  }

  @RequirePermission('marketing.view')
  @Get(':campaignId')
  detail(
    @Param('campaignId') campaignId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.getDetail(campaignId, request.authorization!);
  }

  @RequirePermission('marketing.manage')
  @Post()
  create(
    @Body() body: CreateCampaignRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.create(
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('marketing.manage')
  @Patch(':campaignId')
  update(
    @Param('campaignId') campaignId: string,
    @Body() body: UpdateCampaignRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.update(
      campaignId,
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  @RequirePermission('marketing.manage')
  @Post(':campaignId/status')
  updateStatus(
    @Param('campaignId') campaignId: string,
    @Body() body: UpdateCampaignStatusRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.updateStatus(
      campaignId,
      body?.status,
      request.internalUser!.id,
      request.authorization!,
    );
  }
}
