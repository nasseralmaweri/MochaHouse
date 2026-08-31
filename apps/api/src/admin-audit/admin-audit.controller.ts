import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAuditReadService } from './admin-audit.read-service';
import { InternalAuthGuard } from '../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../internal-auth/infrastructure/internal-identity';

// Administration → Activity log (Milestone 5F). Read-only.
//
// InternalAuthGuard then PermissionGuard. `audit.view` is CORPORATE-only in
// the permission catalog, so a LOCATION-scoped grant can never satisfy
// `PermissionGuard.has()`; the service also calls `assertCorporate`. There
// is no write route — the activity log cannot be edited, deleted or
// exported.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/audit')
export class AdminAuditController {
  constructor(private readonly service: AdminAuditReadService) {}

  @RequirePermission('audit.view')
  @Get()
  list(
    @Req() request: InternalAuthenticatedRequest,
    @Query('cursor') cursor?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('actor') actor?: string,
  ) {
    return this.service.list(
      { cursor, type, from, to, actor },
      request.authorization!,
    );
  }
}
