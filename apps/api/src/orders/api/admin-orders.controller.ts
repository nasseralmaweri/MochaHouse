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
import type {
  AdvanceOrderStatusRequest,
  CancelOrderRequest,
  CreateOrderRefundRequest,
  RejectOrderRequest,
  ReviewOrderRefundRequest,
} from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { AdminOrdersService } from '../application/admin-orders.service';
import { OrderClosureService } from '../application/order-closure.service';
import { OrderRefundsService } from '../application/order-refunds.service';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
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
    private readonly orderRefundsService: OrderRefundsService,
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

  // --- ESP-04 M5b: card refunds ------------------------------------------------
  // Reads need `orders.view` at the location. Refunding, rechecking and
  // reviewing a refund need `orders.refund` at the order's location — checked
  // (and a denial audited) in the service for the specific location, after
  // the guard has admitted staff who can see orders; execution is OFF (404)
  // unless RESTAURANT_REFUNDS_ENABLED=1 with Stripe payments configured and
  // the business on the test-mode allowlist. Refunding the business's
  // customers stays possible during a billing wind-down.

  // Rejected / cancelled orders at the location whose card money is still
  // owed (from their refund records), or that need attention. Declared
  // before ':orderId'.
  @AllowDuringBillingWindDown()
  @RequirePermission('orders.view')
  @Get('refund-obligations')
  listRefundObligations(
    @Query('locationId') locationId: string,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.orderRefundsService.listObligations(
      locationId,
      request.internalUser!,
      request.authorization!,
      tenant,
    );
  }

  @AllowDuringBillingWindDown()
  @RequirePermission('orders.view')
  @Get(':orderId/refunds')
  listRefunds(
    @Param('orderId') orderId: string,
    @Query('locationId') locationId: string,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.orderRefundsService.listForOrder(
      orderId,
      locationId,
      request.internalUser!,
      request.authorization!,
      tenant,
    );
  }

  @AllowDuringBillingWindDown()
  @RequirePermission('orders.view')
  @UseGuards(RateLimitGuard)
  @RateLimit('restaurant-refunds')
  @Post(':orderId/refunds')
  requestRefund(
    @Param('orderId') orderId: string,
    @Body() body: CreateOrderRefundRequest,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.orderRefundsService.request(
      orderId,
      body,
      request.internalUser!,
      request.authorization!,
      tenant,
    );
  }

  // An unanswered or pending refund, read back from Stripe now.
  @AllowDuringBillingWindDown()
  @RequirePermission('orders.view')
  @UseGuards(RateLimitGuard)
  @RateLimit('restaurant-refunds')
  @Post(':orderId/refunds/:refundId/recheck')
  recheckRefund(
    @Param('orderId') orderId: string,
    @Param('refundId') refundId: string,
    @Body() body: { locationId: string },
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.orderRefundsService.recheck(
      orderId,
      refundId,
      body,
      request.internalUser!,
      request.authorization!,
      tenant,
    );
  }

  // The audited review a refund whose money came back needs before any
  // replacement refund.
  @AllowDuringBillingWindDown()
  @RequirePermission('orders.view')
  @UseGuards(RateLimitGuard)
  @RateLimit('restaurant-refunds')
  @Post(':orderId/refunds/:refundId/review')
  reviewRefund(
    @Param('orderId') orderId: string,
    @Param('refundId') refundId: string,
    @Body() body: ReviewOrderRefundRequest,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.orderRefundsService.review(
      orderId,
      refundId,
      body,
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

  // SC3c-1 — during a billing wind-down orders the business already took
  // may be fulfilled: an ACCEPTED order moves on to completion, and a
  // RECEIVED order is accepted only if it was paid before the suspension
  // (checked in the service). New orders cannot arrive (the storefront is
  // suspended).
  @AllowDuringBillingWindDown()
  @RequirePermission('orders.manage_status')
  @Post(':orderId/advance')
  advance(
    @Param('orderId') orderId: string,
    @Body() body: AdvanceOrderStatusRequest,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.adminOrdersService.advance(
      orderId,
      body.locationId,
      body.expectedStatus,
      request.authorization!,
      tenant,
      request.internalBusinessAccess === 'BILLING_WIND_DOWN',
    );
  }
}
