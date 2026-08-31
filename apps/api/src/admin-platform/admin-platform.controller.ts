import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AdminPlatformStatusService } from './admin-platform-status.service';
import { InternalAuthGuard } from '../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../internal-auth/infrastructure/internal-identity';

// Administration → Platform Status (Milestone 5G). Read-only.
//
// InternalAuthGuard then PermissionGuard. `platform.view` is CORPORATE-only
// in the permission catalog, so a LOCATION-scoped grant can never satisfy
// `PermissionGuard.has()`; the service also calls `assertCorporate`. There
// is no write route — platform status cannot be edited.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/platform')
export class AdminPlatformController {
  constructor(private readonly service: AdminPlatformStatusService) {}

  @RequirePermission('platform.view')
  @Get('status')
  status(@Req() request: InternalAuthenticatedRequest) {
    return this.service.getStatus(request.authorization!);
  }
}
