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
import type { RejectApprovalRequestRequest } from '@mocha-house/contracts';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { ApprovalsAdminService } from '../application/approvals-admin.service';

// Admin → Approvals (Milestone 8J). InternalAuthGuard then PermissionGuard.
//   approvals.view    — list / detail.
//   approvals.decide  — approve / reject.
// Both CORPORATE-only; every service method also calls assertCorporate,
// and — since this slice wires only Campaign approvals — also requires
// marketing.view (see ApprovalsAdminService).
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/approvals')
export class AdminApprovalsController {
  constructor(private readonly service: ApprovalsAdminService) {}

  @RequirePermission('approvals.view')
  @Get()
  list(
    @Req() request: InternalAuthenticatedRequest,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.list({ status, cursor }, request.authorization!);
  }

  @RequirePermission('approvals.view')
  @Get(':approvalRequestId')
  async getOne(
    @Param('approvalRequestId') approvalRequestId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    const approvalRequest = await this.service.getOne(
      approvalRequestId,
      request.authorization!,
    );
    return { approvalRequest };
  }

  @RequirePermission('approvals.decide')
  @Post(':approvalRequestId/approve')
  async approve(
    @Param('approvalRequestId') approvalRequestId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    const approvalRequest = await this.service.approve(
      approvalRequestId,
      request.internalUser!.id,
      request.authorization!,
    );
    return { approvalRequest };
  }

  @RequirePermission('approvals.decide')
  @Post(':approvalRequestId/reject')
  async reject(
    @Param('approvalRequestId') approvalRequestId: string,
    @Body() body: RejectApprovalRequestRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    const approvalRequest = await this.service.reject(
      approvalRequestId,
      body?.reason,
      request.internalUser!.id,
      request.authorization!,
    );
    return { approvalRequest };
  }
}
