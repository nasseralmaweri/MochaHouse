import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  CheckoutPaymentCheckRequest,
  CheckoutPaymentSimulationRequest,
  CheckoutQuoteRequest,
  CheckoutRequest,
  CheckoutSessionRequest,
  CheckoutSubmitResult,
  OrderConfirmation,
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
  //
  // ESP-04 M2 — 201 with the order (unchanged), or 202 with
  // CheckoutPaymentRequiredResponse when a two-step payment now waits for
  // the customer to confirm it.
  @Post()
  async checkout(
    @Body() body: CheckoutRequest,
    @Req() request: CustomerAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.checkoutService.submit(
      body,
      request.customerIdentity,
      tenant,
    );
    return answer(result, response);
  }

  // ESP-04 M2 — check this checkout's two-step payment with the payment
  // provider (never the browser's word): 200 with the order, 202 while it
  // waits for the customer or the provider, 402 when it did not go through,
  // 409 while the outcome is not known. The body names only the session.
  @UseGuards(OptionalCustomerAuthGuard, RateLimitGuard)
  @RateLimit('checkout')
  @Header('Cache-Control', 'no-store')
  @Post('checkout-sessions/payment')
  @HttpCode(HttpStatus.OK)
  async checkPayment(
    @Body() body: CheckoutPaymentCheckRequest,
    @Req() request: CustomerAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.checkoutService.checkPayment(
      body,
      request.customerIdentity,
      tenant,
    );
    return answer(result, response);
  }

  // ESP-04 M2 — DEVELOPMENT AND TESTS ONLY: the payment simulator for the
  // two-step fake provider. 404 everywhere else (see
  // CheckoutService.simulatePayment).
  @UseGuards(OptionalCustomerAuthGuard, RateLimitGuard)
  @RateLimit('checkout')
  @Header('Cache-Control', 'no-store')
  @Post('checkout-sessions/payment/simulate')
  @HttpCode(HttpStatus.NO_CONTENT)
  async simulatePayment(
    @Body() body: CheckoutPaymentSimulationRequest,
    @Req() request: CustomerAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<void> {
    await this.checkoutService.simulatePayment(
      body,
      request.customerIdentity,
      tenant,
    );
  }

  // ESP-03 PR 6 — start (or resume) the server-owned checkout session that a
  // food-order payment and all of its retries are bound to. Guest-friendly;
  // never charges. 200: it may return an existing session.
  @UseGuards(OptionalCustomerAuthGuard, RateLimitGuard)
  @RateLimit('checkout-quote')
  @Header('Cache-Control', 'no-store')
  @Post('checkout-sessions')
  @HttpCode(HttpStatus.OK)
  startSession(
    @Body() body: CheckoutSessionRequest,
    @Req() request: CustomerAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.checkoutService.startSession(
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

  // Guest order access: the id alone is not authorization, the access token is
  // the actual credential (see CheckoutService.getStatus).
  //
  // R1 / S3c — the token is read from the X-Order-Access-Token header (the web
  // tier sends it there, so it never lands in a request URL or its logs). The
  // ?accessToken= query form is still accepted as a DEPRECATED compatibility
  // path for existing callers; the header wins when both are present. The
  // response is never cacheable.
  //
  // R1 / S3a — rate limited per order (generous: customer tracking polls every
  // 15 s per tab) and, separately, by RECENT FAILED lookups from one client. The
  // failure scope counts a lookup as it arrives (so a concurrent burst of
  // guesses is limited at once) and the count is given back when the lookup
  // succeeds, so a customer's successful polls never accumulate.
  @UseGuards(RateLimitGuard)
  @RateLimit('order-status')
  @Header('Cache-Control', 'no-store')
  @Get(':orderId')
  async getStatus(
    @Param('orderId') orderId: string,
    @Headers('x-order-access-token') headerToken: string | undefined,
    @Query('accessToken') queryToken: string | undefined,
    @CurrentTenantContext() tenant: TenantContext,
    @Req() request: CustomerAuthenticatedRequest,
  ) {
    const status = await this.checkoutService.getStatus(
      orderId,
      pickAccessToken(headerToken, queryToken),
      tenant,
    );
    await this.rateLimits.releaseOnSuccess(request);
    return status;
  }
}

// ESP-04 M2 — a completed checkout answers with its order exactly as before;
// a payment waiting for its customer answers 202.
function answer(
  result: CheckoutSubmitResult,
  response: Response,
): OrderConfirmation | CheckoutSubmitResult {
  if (result.outcome === 'COMPLETED') {
    return result.confirmation;
  }
  response.status(HttpStatus.ACCEPTED);
  return result;
}

// Header wins; a repeated header or query parameter (array) is not a usable
// credential, so it reads as no token and the normal not-found answer.
export function pickAccessToken(
  header: string | string[] | undefined,
  query: string | string[] | undefined,
): string {
  const value = header ?? query;
  return typeof value === 'string' ? value : '';
}
