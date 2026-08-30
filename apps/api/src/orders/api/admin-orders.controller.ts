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
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';

// Protected by InternalAuthGuard (Milestone 5A): the caller must present a
// valid internal identity token that maps to an ACTIVE Mocha House
// InternalUser. There is still no Role/Permission/Scope enforcement
// (Milestone 5B) — ACTIVE internal-user authentication is the entire gate.
// Every route is already location-scoped (path param or request body)
// specifically so a real scope check can be added later without touching
// the service layer or the routes themselves.
@UseGuards(InternalAuthGuard)
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
