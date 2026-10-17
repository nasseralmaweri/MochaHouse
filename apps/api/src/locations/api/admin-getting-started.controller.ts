import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@mocha-house/database';
import { GettingStartedService } from '../application/getting-started.service';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';

// SC4d — the business's getting-started checklist. Read-only, computed from
// the business's own data; corporate `locations.view` (asserted again in the
// service).
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/getting-started')
export class AdminGettingStartedController {
  constructor(private readonly gettingStarted: GettingStartedService) {}

  @RequirePermission('locations.view')
  @Get()
  checklist(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.gettingStarted.checklist(request.authorization!, tenant);
  }
}
