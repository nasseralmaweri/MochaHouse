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
import type { CheckoutRequest } from '@mocha-house/contracts';
import { OptionalCustomerAuthGuard } from '../../customer-auth/infrastructure/optional-customer-auth.guard';
import type { CustomerAuthenticatedRequest } from '../../customer-auth/infrastructure/customer-identity';
import { CheckoutService } from '../application/checkout.service';

@Controller('api/v1/orders')
export class OrdersController {
  constructor(private readonly checkoutService: CheckoutService) {}

  // OptionalCustomerAuthGuard never rejects this request — it only
  // attaches customerIdentity when a valid session was presented, so
  // guest checkout (no Authorization header at all) is completely
  // unaffected. See CheckoutService.resolveCustomerId for what happens
  // with an invalid/expired one.
  @UseGuards(OptionalCustomerAuthGuard)
  @Post()
  checkout(
    @Body() body: CheckoutRequest,
    @Req() request: CustomerAuthenticatedRequest,
  ) {
    return this.checkoutService.checkout(body, request.customerIdentity);
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
