import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  BUSINESS_BILLING_SUSPENDED,
  type AdvanceOrderStatusRequest,
  type CancelOrderRequest,
  type RejectOrderRequest,
} from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { AdminOrdersService } from '../application/admin-orders.service';
import { OrderClosureService } from '../application/order-closure.service';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import { AllowDuringBillingWindDown } from '../../internal-auth/infrastructure/billing-wind-down.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';

// Protected by InternalAuthGuard (authentication + ACTIVE lifecycle) then
// PermissionGuard (Milestone 5B — required permission + valid scope type).
// The service layer additionally enforces that the caller is authorized for
// the specific location and that the persisted order actually belongs to
// it. `locationId` stays a REQUIRED query/body parameter (unchanged
// contract) — it is a filter, never proof of authorization.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/orders')
export class AdminOrdersController {
  constructor(
    private readonly adminOrdersService: AdminOrdersService,
    private readonly orderClosureService: OrderClosureService,
  ) {}

  // R1 / S5b — reject a RECEIVED order. Off (404) unless
  // ORDER_CLOSURE_ENABLED=1. `orders.cancel` is checked again for the
  // specific location in the service, and the order must belong to that
  // location and to the request's business.
  // SC3c-1 — rejecting (refunding) an order the business already took is
  // part of a billing wind-down; ORDER_CLOSURE_ENABLED still gates it.
  @AllowDuringBillingWindDown()
  @RequirePermission('orders.cancel')
  @Post(':orderId/reject')
  reject(
    @Param('orderId') orderId: string,
    @Body() body: RejectOrderRequest,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.orderClosureService.close(
      {
        kind: 'REJECTED',
        orderId,
        locationId: body?.locationId,
        reasonCode: body?.reasonCode,
        note: body?.note,
      },
      request.internalUser!,
      request.authorization!,
      tenant,
    );
  }

  // R1 / S5b — cancel an ACCEPTED / PREPARING / READY order (same gates).
  @AllowDuringBillingWindDown()
  @RequirePermission('orders.cancel')
  @Post(':orderId/cancel')
  cancel(
    @Param('orderId') orderId: string,
    @Body() body: CancelOrderRequest,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.orderClosureService.close(
      {
        kind: 'CANCELLED',
        orderId,
        locationId: body?.locationId,
        expectedStatus: body?.expectedStatus,
        reasonCode: body?.reasonCode,
        note: body?.note,
      },
      request.internalUser!,
      request.authorization!,
      tenant,
    );
  }

  @AllowDuringBillingWindDown()
  @RequirePermission('orders.view')
  @Get()
  listActive(
    @Query('locationId') locationId: string,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.adminOrdersService.listActive(
      locationId,
      request.authorization!,
      tenant,
    );
  }

  @AllowDuringBillingWindDown()
  @RequirePermission('orders.view')
  @Get(':orderId')
  getDetail(
    @Param('orderId') orderId: string,
    @Query('locationId') locationId: string,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.adminOrdersService.getDetail(
      orderId,
      locationId,
      request.authorization!,
      tenant,
    );
  }

  // SC3c-1 — during a billing wind-down only orders the business already
  // ACCEPTED may be moved on (to completion); a RECEIVED order is not
  // accepted then (that would be a new sale).
  @AllowDuringBillingWindDown()
  @RequirePermission('orders.manage_status')
  @Post(':orderId/advance')
  advance(
    @Param('orderId') orderId: string,
    @Body() body: AdvanceOrderStatusRequest,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    if (
      request.internalBusinessAccess === 'BILLING_WIND_DOWN' &&
      body?.expectedStatus === 'RECEIVED'
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: BUSINESS_BILLING_SUSPENDED,
        message:
          'This business is suspended for billing: new orders cannot be accepted. Orders already accepted can still be completed.',
      });
    }
    return this.adminOrdersService.advance(
      orderId,
      body.locationId,
      body.expectedStatus,
      request.authorization!,
      tenant,
    );
  }
}
