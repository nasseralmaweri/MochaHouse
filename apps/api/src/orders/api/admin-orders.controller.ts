import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { AdvanceOrderStatusRequest } from '@mocha-house/contracts';
import { AdminOrdersService } from '../application/admin-orders.service';
import { DevInternalGuard } from '../infrastructure/dev-internal.guard';

// DEV-ONLY / INTERNAL: DevInternalGuard is a placeholder that allows every
// request through — there is no Role/Permission/Scope enforcement yet.
// This controller must not be exposed beyond a trusted internal caller
// until that exists. Every route is already location-scoped (path param
// or request body) specifically so a real guard can check "is this caller
// permitted to act on this location" later without touching the service
// layer or the routes themselves.
@UseGuards(DevInternalGuard)
@Controller('api/v1/admin/orders')
export class AdminOrdersController {
  constructor(private readonly adminOrdersService: AdminOrdersService) {}

  @Get()
  listActive(@Query('locationId') locationId: string) {
    return this.adminOrdersService.listActive(locationId);
  }

  @Get(':orderId')
  getDetail(
    @Param('orderId') orderId: string,
    @Query('locationId') locationId: string,
  ) {
    return this.adminOrdersService.getDetail(orderId, locationId);
  }

  @Post(':orderId/advance')
  advance(
    @Param('orderId') orderId: string,
    @Body() body: AdvanceOrderStatusRequest,
  ) {
    return this.adminOrdersService.advance(
      orderId,
      body.locationId,
      body.expectedStatus,
    );
  }
}
