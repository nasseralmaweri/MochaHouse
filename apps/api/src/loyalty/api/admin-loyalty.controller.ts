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
import type { AdminAdjustMochaBeansRequest } from '@mocha-house/contracts';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { LoyaltyAdminService } from '../application/loyalty-admin.service';

// The HQ Mocha Beans surface (Milestone 7A). InternalAuthGuard
// (authentication + ACTIVE lifecycle) then PermissionGuard. `loyalty.view`
// and `loyalty.adjust` are both CORPORATE-only in the permission catalog,
// so a LOCATION grant can never satisfy PermissionGuard.has(); each service
// method also calls assertCorporate. This controller never exposes anything
// but loyalty data — it is not a customer-management module.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/loyalty')
export class AdminLoyaltyController {
  constructor(private readonly service: LoyaltyAdminService) {}

  @RequirePermission('loyalty.view')
  @Get('customers')
  search(
    @Query('query') query: string | undefined,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.searchCustomers(query, request.authorization!);
  }

  @RequirePermission('loyalty.view')
  @Get('customers/:customerId')
  detail(
    @Param('customerId') customerId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.getCustomerDetail(customerId, request.authorization!);
  }

  // Manual add/deduct. `reason` and `operationKey` are required; the actor
  // is taken from the authenticated request (never the body); the resulting
  // balance can never go below zero; a repeated operationKey is idempotent.
  @RequirePermission('loyalty.adjust')
  @Post('customers/:customerId/adjustments')
  adjust(
    @Param('customerId') customerId: string,
    @Body() body: AdminAdjustMochaBeansRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.service.adjust(
      customerId,
      body,
      request.internalUser!.id,
      request.authorization!,
    );
  }
}
