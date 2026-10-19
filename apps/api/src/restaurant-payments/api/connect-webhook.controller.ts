import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { PaymentAccountsService } from '../application/payment-accounts.service';
import {
  CONNECT_ACCOUNT_PROVIDER,
  ConnectEventVerificationError,
  type ConnectAccountProvider,
  type VerifiedConnectEvent,
} from '../provider/connect-account-provider';

// ESP-04 M1 — restaurant-payments (Stripe Connect) webhooks
// (POST /api/v1/restaurant-payments/webhooks/:provider). A separate endpoint
// and signing secret from CENTERIVO's SaaS billing webhooks. No session and no
// business context: the ONLY credential is the provider's signature over the
// ORIGINAL raw body (rawBody is enabled at bootstrap); unverifiable requests
// are refused before anything is read or recorded. Excluded from the tenant
// middleware. The business is found from OUR stored account id, never from
// the event, and the account's state is read back from Stripe.
//
// Answers: 200 when the event is durably handled (processed, ignored or a
// duplicate); 503 when it could not be processed yet so the provider
// retries; 400 for an unverifiable request; 404 when this provider is not the
// one configured.
@Controller('api/v1/restaurant-payments/webhooks')
export class ConnectWebhookController {
  constructor(
    private readonly accounts: PaymentAccountsService,
    @Inject(CONNECT_ACCOUNT_PROVIDER)
    private readonly provider: ConnectAccountProvider,
  ) {}

  @UseGuards(RateLimitGuard)
  @RateLimit('payments-connect-webhook')
  @HttpCode(200)
  @Post(':provider')
  async receive(
    @Param('provider') providerName: string,
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    if (!this.provider.available || providerName !== this.provider.name) {
      throw new NotFoundException();
    }
    const rawBody = request.rawBody;
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      throw new BadRequestException('Unverifiable request.');
    }
    let verified: VerifiedConnectEvent;
    try {
      verified = this.provider.verifyEvent({
        rawBody,
        signatureHeader: signature,
      });
    } catch (error) {
      if (error instanceof ConnectEventVerificationError) {
        throw new BadRequestException('Unverifiable request.');
      }
      throw error;
    }
    if (!(await this.accounts.handleEvent(verified))) {
      // Not durably handled yet: the provider retries.
      throw new ServiceUnavailableException('Try again later.');
    }
    return { received: true };
  }
}
