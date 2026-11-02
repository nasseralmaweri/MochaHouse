import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import type { PaymentProvider } from '@mocha-house/integrations';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { PAYMENT_PROVIDER } from '../../payment/payment-provider.token';
import {
  PaymentEventVerificationError,
  StripePaymentIntentProvider,
  type VerifiedPaymentEvent,
} from '../provider/stripe-payment-intent-provider';
import { PaymentEventsService } from './payment-events.service';

// ESP-04 M3 (B1) — Stripe PAYMENT events about intents on the restaurants'
// connected accounts (POST /api/v1/restaurant-payments/webhooks/stripe/payments),
// a separate endpoint and signing secret from the M1 account events and from
// CENTERIVO's SaaS billing webhooks. No session and no business context: the
// ONLY credential is Stripe's signature over the ORIGINAL raw body (rawBody
// is enabled at bootstrap); unverifiable requests are refused before
// anything is read or recorded. Excluded from the tenant middleware (the
// restaurant-payments webhooks prefix).
//
// Answers: 200 ONLY when the event is finally handled (processed, ignored,
// kept as unmatched, or not ours); 503 when it is not finished yet, so Stripe
// delivers it again; 400 for an unverifiable request; 404 when Stripe
// payments are not configured.
@Controller('api/v1/restaurant-payments/webhooks/stripe')
export class PaymentEventsController {
  constructor(
    private readonly events: PaymentEventsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  @UseGuards(RateLimitGuard)
  @RateLimit('payments-intent-webhook')
  @HttpCode(200)
  @Post('payments')
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    const provider = this.provider;
    if (!(provider instanceof StripePaymentIntentProvider)) {
      throw new NotFoundException();
    }
    const rawBody = request.rawBody;
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      throw new BadRequestException('Unverifiable request.');
    }
    let verified: VerifiedPaymentEvent;
    try {
      verified = provider.verifyPaymentEvent({
        rawBody,
        signatureHeader: signature,
      });
    } catch (error) {
      if (error instanceof PaymentEventVerificationError) {
        throw new BadRequestException('Unverifiable request.');
      }
      throw error;
    }
    if (!(await this.events.handle(verified))) {
      throw new ServiceUnavailableException('Try again later.');
    }
    return { received: true };
  }
}
