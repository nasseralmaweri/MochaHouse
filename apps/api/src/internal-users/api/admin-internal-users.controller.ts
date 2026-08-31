import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AdminUpdateInternalUserStatusRequest } from '@mocha-house/contracts';
import { AdminInternalUsersService } from '../application/admin-internal-users.service';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';

// Administration → Users: read (Milestone 5E-1) and status management
// (Milestone 5E-3).
//
// InternalAuthGuard (authentication + ACTIVE lifecycle) then PermissionGuard.
// `users.view` and `users.manage_status` are both CORPORATE-only in the
// permission catalog, so a LOCATION-scoped grant can never satisfy
// `PermissionGuard.has()`; each service method also calls `assertCorporate`.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/internal-users')
export class AdminInternalUsersController {
  constructor(private readonly service: AdminInternalUsersService) {}

  @RequirePermission('users.view')
  @Get()
  listUsers(@Req() request: InternalAuthenticatedRequest) {
    return this.service.listUsers(request.authorization!);
  }

  @RequirePermission('users.view')
  @Get(':internalUserId')
  getUser(
    @Param('internalUserId') internalUserId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.getUserDetail(internalUserId, request.authorization!);
  }

  // Suspend / reactivate / disable another internal user. `reason` is
  // required; the actor is taken from the authenticated request (never the
  // body); self-management and last-administrator loss are rejected in the
  // service, transactionally.
  @RequirePermission('users.manage_status')
  @Patch(':internalUserId/status')
  updateStatus(
    @Param('internalUserId') internalUserId: string,
    @Body() body: AdminUpdateInternalUserStatusRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.updateStatus(
      internalUserId,
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }
}
