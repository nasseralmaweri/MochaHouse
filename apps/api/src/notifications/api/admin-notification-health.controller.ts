import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@mocha-house/database';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';
import { NotificationHealthService } from '../application/notification-health.service';

// R1 / S4c — read-only notification health for the caller's own business.
// InternalAuthGuard (authentication + ACTIVE lifecycle) then PermissionGuard.
// Uses the existing notifications.routing.view permission (CORPORATE-only):
// the same administrators who can see where notifications are routed can see
// whether they are being delivered. The tenant always comes from the
// server-resolved TenantContext, never from the request. No actions: viewing
// only (no re-send, no re-drive).
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/notifications/health')
export class AdminNotificationHealthController {
  constructor(private readonly service: NotificationHealthService) {}

  @RequirePermission('notifications.routing.view')
  @Get()
  summary(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.service.summary(request.authorization!, tenant);
  }
}
