import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { CheckoutRewardEligibilityRequest } from '@mocha-house/contracts';
import { CustomerAuthGuard } from '../../customer-auth/infrastructure/customer-auth.guard';
import type { CustomerAuthenticatedRequest } from '../../customer-auth/infrastructure/customer-identity';
import { CheckoutService } from '../application/checkout.service';

// Milestone 7C — the checkout reward-eligibility quote. Separate from
// OrdersController because this one REQUIRES a signed-in customer
// (CustomerAuthGuard is mandatory here — a guest has no rewards), whereas
// OrdersController's checkout is guest-friendly (OptionalCustomerAuthGuard).
//
// POST (not GET) for the same reason the reorder endpoint is POST: the cart
// lines don't fit a query string cleanly. It creates nothing — 200, not
// 201 — reserves nothing and deducts nothing.
@UseGuards(CustomerAuthGuard)
@Controller('api/v1/orders')
export class CheckoutRewardsController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Post('reward-eligibility')
  @HttpCode(HttpStatus.OK)
  quote(
    @Body() body: CheckoutRewardEligibilityRequest,
    @Req() request: CustomerAuthenticatedRequest,
  ) {
    // CustomerAuthGuard always sets this before a request reaches here.
    return this.checkoutService.quoteRewardEligibility(
      body,
      request.customerIdentity!,
    );
  }
}
