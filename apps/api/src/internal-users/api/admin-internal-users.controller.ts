import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { AdminInternalUsersService } from '../application/admin-internal-users.service';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';

// Administration → Users (Milestone 5E-1). Read-only.
//
// InternalAuthGuard (authentication + ACTIVE lifecycle) then PermissionGuard.
// `users.view` is CORPORATE-only in the permission catalog, so a
// LOCATION-scoped grant can never satisfy `PermissionGuard.has()`; the
// service also calls `assertCorporate('users.view')` as the matching
// service-layer defense. There are no write routes in this slice.
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
}
