import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  CheckoutQuoteRequest,
  CheckoutRequest,
} from '@mocha-house/contracts';
import { OptionalCustomerAuthGuard } from '../../customer-auth/infrastructure/optional-customer-auth.guard';
import type { CustomerAuthenticatedRequest } from '../../customer-auth/infrastructure/customer-identity';
import type { TenantContext } from '@mocha-house/database';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';
import { CheckoutService } from '../application/checkout.service';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import {
  RateLimitEnforcer,
  RateLimitGuard,
} from '../../rate-limit/rate-limit.guard';

@Controller('api/v1/orders')
export class OrdersController {
  constructor(
    private readonly checkoutService: CheckoutService,
    private readonly rateLimits: RateLimitEnforcer,
  ) {}

  // OptionalCustomerAuthGuard never rejects this request — it only
  // attaches customerIdentity when a valid session was presented, so
  // guest checkout (no Authorization header at all) is completely
  // unaffected. See CheckoutService.resolveCustomerId for what happens
  // with an invalid/expired one.
  @UseGuards(OptionalCustomerAuthGuard, RateLimitGuard)
  @RateLimit('checkout')
  @Post()
  checkout(
    @Body() body: CheckoutRequest,
    @Req() request: CustomerAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.checkoutService.checkout(
      body,
      request.customerIdentity,
      tenant,
    );
  }

  // Milestone 7E — the unified checkout pricing quote. Guest-friendly
  // (OptionalCustomerAuthGuard), read-only (200, not 201): it consumes no
  // redemption, reserves nothing and deducts no Beans.
  @UseGuards(OptionalCustomerAuthGuard, RateLimitGuard)
  @RateLimit('checkout-quote')
  @Post('checkout-quote')
  @HttpCode(HttpStatus.OK)
  quote(
    @Body() body: CheckoutQuoteRequest,
    @Req() request: CustomerAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.checkoutService.quoteCheckout(
      body,
      request.customerIdentity,
      tenant,
    );
  }

  // Guest order access: the id alone is not authorization, accessToken is
  // the actual credential (see CheckoutService.getStatus).
  //
  // R1 / S3a — rate limited per order (generous: customer tracking polls every
  // 15 s per tab) and, separately, by RECENT FAILED lookups from one client. The
  // failure scope counts a lookup as it arrives (so a concurrent burst of
  // guesses is limited at once) and the count is given back when the lookup
  // succeeds, so a customer's successful polls never accumulate.
  @UseGuards(RateLimitGuard)
  @RateLimit('order-status')
  @Get(':orderId')
  async getStatus(
    @Param('orderId') orderId: string,
    @Query('accessToken') accessToken: string,
    @CurrentTenantContext() tenant: TenantContext,
    @Req() request: CustomerAuthenticatedRequest,
  ) {
    const status = await this.checkoutService.getStatus(
      orderId,
      accessToken ?? '',
      tenant,
    );
    await this.rateLimits.releaseOnSuccess(request);
    return status;
  }
}
