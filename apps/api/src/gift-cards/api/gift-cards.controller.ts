import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  CreateGiftCardPurchaseIntentRequest,
  GiftCardBalanceRequest,
  PurchaseGiftCardRequest,
} from '@mocha-house/contracts';
import { OptionalCustomerAuthGuard } from '../../customer-auth/infrastructure/optional-customer-auth.guard';
import type { CustomerAuthenticatedRequest } from '../../customer-auth/infrastructure/customer-identity';
import { GiftCardPublicThrottleGuard } from '../infrastructure/gift-card-public-throttle.guard';
import { GiftCardBalanceService } from '../application/gift-card-balance.service';
import { GiftCardPurchaseService } from '../application/gift-card-purchase.service';
import { GiftCardConfigurationService } from '../application/gift-card-configuration.service';

// Milestone 7H — the PUBLIC customer gift-card surface (no HQ permissions).
//   GET  /api/v1/gift-cards/purchase-options  — amount rules for the page
//        (read-only; no throttle).
//   POST /api/v1/gift-cards/purchase-intents  — step 1: establish a PENDING
//        purchase, no charge; returns a guest's one-time recovery credential.
//   POST /api/v1/gift-cards/purchase          — step 2: charge + issue, or
//        replay the confirmation (full code only to an authorised caller).
//   POST /api/v1/gift-cards/balance           — check a balance by code.
// The two purchase steps and the balance lookup carry code / credentials in
// the POST body ONLY and the minimal endpoint-specific throttle
// (GiftCardPublicThrottleGuard) — 20 req/min/IP, fail-open on Redis error.
// OptionalCustomerAuthGuard: guests allowed; a valid session links the
// purchase to the customer.
@Controller('api/v1/gift-cards')
export class GiftCardsController {
  constructor(
    private readonly purchaseService: GiftCardPurchaseService,
    private readonly balanceService: GiftCardBalanceService,
    private readonly configuration: GiftCardConfigurationService,
  ) {}

  @Get('purchase-options')
  purchaseOptions() {
    return this.configuration.getPublicOptions();
  }

  @UseGuards(GiftCardPublicThrottleGuard, OptionalCustomerAuthGuard)
  @Post('purchase-intents')
  createPurchaseIntent(
    @Body() body: CreateGiftCardPurchaseIntentRequest,
    @Req() request: CustomerAuthenticatedRequest,
  ) {
    return this.purchaseService.createIntent(body, request.customerIdentity);
  }

  @UseGuards(GiftCardPublicThrottleGuard, OptionalCustomerAuthGuard)
  @Post('purchase')
  purchase(
    @Body() body: PurchaseGiftCardRequest,
    @Req() request: CustomerAuthenticatedRequest,
  ) {
    return this.purchaseService.purchase(body, request.customerIdentity);
  }

  @UseGuards(GiftCardPublicThrottleGuard)
  @Post('balance')
  @HttpCode(HttpStatus.OK)
  balance(@Body() body: GiftCardBalanceRequest) {
    return this.balanceService.lookup(body?.code);
  }
}
