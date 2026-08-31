import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { AdminInternalRolesService } from '../application/admin-internal-roles.service';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';

// Administration → Access Levels (Milestone 5E-2). Read-only.
//
// InternalAuthGuard then PermissionGuard. `roles.view` is CORPORATE-only in
// the permission catalog, so a LOCATION-scoped grant can never satisfy
// `PermissionGuard.has()`; the service also calls `assertCorporate`. No
// write routes in this slice — creating / renaming / editing an access level
// is deferred.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/internal-roles')
export class AdminInternalRolesController {
  constructor(private readonly service: AdminInternalRolesService) {}

  @RequirePermission('roles.view')
  @Get()
  listRoles(@Req() request: InternalAuthenticatedRequest) {
    return this.service.listRoles(request.authorization!);
  }

  @RequirePermission('roles.view')
  @Get(':internalRoleId')
  getRole(
    @Param('internalRoleId') internalRoleId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.getRoleDetail(internalRoleId, request.authorization!);
  }
}
