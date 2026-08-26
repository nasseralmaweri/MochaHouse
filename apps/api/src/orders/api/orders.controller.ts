import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { CheckoutRequest } from '@mocha-house/contracts';
import { CheckoutService } from '../application/checkout.service';

@Controller('api/v1/orders')
export class OrdersController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Post()
  checkout(@Body() body: CheckoutRequest) {
    return this.checkoutService.checkout(body);
  }

  // Guest order access: the id alone is not authorization, accessToken is
  // the actual credential (see CheckoutService.getStatus).
  @Get(':orderId')
  getStatus(
    @Param('orderId') orderId: string,
    @Query('accessToken') accessToken: string,
  ) {
    return this.checkoutService.getStatus(orderId, accessToken ?? '');
  }
}
