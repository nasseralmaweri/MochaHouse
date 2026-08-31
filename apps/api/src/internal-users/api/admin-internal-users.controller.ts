import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  AdminAssignInternalUserRoleRequest,
  AdminRemoveInternalUserRoleAssignmentRequest,
  AdminUpdateInternalUserStatusRequest,
} from '@mocha-house/contracts';
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

  // The access-assignment picker data (Milestone 5E-4). Declared BEFORE the
  // `:internalUserId` route so the literal path is not captured as an id.
  // Gated by `users.manage_roles` — `roles.view` is NOT also required.
  @RequirePermission('users.manage_roles')
  @Get('access-options')
  getAccessOptions(@Req() request: InternalAuthenticatedRequest) {
    return this.service.getAccessOptions(request.authorization!);
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

  // Grant an access level at corporate or specific-location scope
  // (Milestone 5E-4). `reason` required; actor from the request; self-target
  // rejected; privilege ceiling, assignment policy and last-administrator
  // protection all enforced in the service, transactionally.
  @RequirePermission('users.manage_roles')
  @Post(':internalUserId/role-assignments')
  assignRole(
    @Param('internalUserId') internalUserId: string,
    @Body() body: AdminAssignInternalUserRoleRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.assignRole(
      internalUserId,
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }

  // Remove ONE concrete access grant (Milestone 5E-4). A POST-with-body
  // removal (not DELETE-with-body) so the required `reason` always travels
  // in a conventional place.
  @RequirePermission('users.manage_roles')
  @Post(':internalUserId/role-assignments/:assignmentId/remove')
  removeRoleAssignment(
    @Param('internalUserId') internalUserId: string,
    @Param('assignmentId') assignmentId: string,
    @Body() body: AdminRemoveInternalUserRoleAssignmentRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.removeRoleAssignment(
      internalUserId,
      assignmentId,
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }
}
