import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import type { UpdateNotificationRecipientRequest } from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';
import { NotificationRecipientConfigurationService } from '../application/notification-recipient-configuration.service';

// HQ configuration of tenant-owned notification recipient routing
// (Milestone S0D-2C-3). InternalAuthGuard (authentication + ACTIVE
// lifecycle) then PermissionGuard.
//   notifications.routing.view    — list the current tenant's recipients.
//   notifications.routing.manage  — create/update one.
// Both CORPORATE-only in the permission catalog, so a LOCATION grant can
// never satisfy PermissionGuard; the service also calls `assertCorporate`.
// Every read and write is scoped to the caller's own tenant via
// @CurrentTenantContext() — never a client-supplied tenant id.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/notifications/recipients')
export class AdminNotificationRecipientsController {
  constructor(private readonly service: NotificationRecipientConfigurationService) {}

  @RequirePermission('notifications.routing.view')
  @Get()
  list(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.service.list(request.authorization!, tenant);
  }

  @RequirePermission('notifications.routing.manage')
  @Put(':purpose')
  update(
    @Param('purpose') purpose: string,
    @Body() body: UpdateNotificationRecipientRequest,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.service.update(
      purpose,
      body,
      request.internalUser!.id,
      request.authorization!,
      tenant,
    );
  }
}
