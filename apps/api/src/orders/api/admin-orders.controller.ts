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
import type { AdvanceOrderStatusRequest } from '@mocha-house/contracts';
import { AdminOrdersService } from '../application/admin-orders.service';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';

// Protected by InternalAuthGuard (authentication + ACTIVE lifecycle) then
// PermissionGuard (Milestone 5B — required permission + valid scope type).
// The service layer additionally enforces that the caller is authorized for
// the specific location and that the persisted order actually belongs to
// it. `locationId` stays a REQUIRED query/body parameter (unchanged
// contract) — it is a filter, never proof of authorization.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/orders')
export class AdminOrdersController {
  constructor(private readonly adminOrdersService: AdminOrdersService) {}

  @RequirePermission('orders.view')
  @Get()
  listActive(
    @Query('locationId') locationId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.adminOrdersService.listActive(
      locationId,
      request.authorization!,
    );
  }

  @RequirePermission('orders.view')
  @Get(':orderId')
  getDetail(
    @Param('orderId') orderId: string,
    @Query('locationId') locationId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.adminOrdersService.getDetail(
      orderId,
      locationId,
      request.authorization!,
    );
  }

  @RequirePermission('orders.manage_status')
  @Post(':orderId/advance')
  advance(
    @Param('orderId') orderId: string,
    @Body() body: AdvanceOrderStatusRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.adminOrdersService.advance(
      orderId,
      body.locationId,
      body.expectedStatus,
      request.authorization!,
    );
  }
}
