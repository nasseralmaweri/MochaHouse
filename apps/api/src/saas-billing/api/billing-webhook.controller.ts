import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { BillingLifecycleService } from '../application/billing-lifecycle.service';
import { BillingComplimentaryService } from '../application/billing-complimentary.service';
import {
  BillingEventVerificationError,
  SAAS_BILLING_PROVIDER,
  type SaasBillingProvider,
  type VerifiedBillingProviderEvent,
} from '../provider/saas-billing-provider';

// SC3b — billing-provider webhooks (POST /api/v1/billing/webhooks/:provider).
// No session and no business context: the ONLY credential is the provider's
// signature over the ORIGINAL raw body (rawBody is enabled at bootstrap).
// Unverifiable requests are refused before anything is read or recorded.
// Excluded from the tenant middleware (a suspended business's payment
// events must still arrive), and it changes billing state only — never a
// business's administrative suspension.
//
// Answers: 200 when the event is durably handled (applied, ignored,
// rejected, or a duplicate); 503 when processing failed transiently so the
// provider retries (F7); 400 for an unverifiable request; 404 when this
// provider is not the one configured.
@Controller('api/v1/billing/webhooks')
export class BillingWebhookController {
  private readonly logger = new Logger(BillingWebhookController.name);

  constructor(
    private readonly lifecycle: BillingLifecycleService,
    private readonly complimentary: BillingComplimentaryService,
    @Inject(SAAS_BILLING_PROVIDER)
    private readonly provider: SaasBillingProvider,
  ) {}

  @UseGuards(RateLimitGuard)
  @RateLimit('billing-webhook')
  @HttpCode(200)
  @Post(':provider')
  async receive(
    @Param('provider') providerName: string,
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') stripeSignature: string | undefined,
    @Headers('x-billing-signature') fakeSignature: string | undefined,
  ): Promise<{ received: true }> {
    if (!this.provider.available || providerName !== this.provider.name) {
      throw new NotFoundException();
    }
    const rawBody = request.rawBody;
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      throw new BadRequestException('Unverifiable request.');
    }
    let verified: VerifiedBillingProviderEvent;
    try {
      verified = this.provider.verifyEvent({
        rawBody,
        signatureHeader:
          this.provider.name === 'stripe' ? stripeSignature : fakeSignature,
      });
    } catch (error) {
      if (error instanceof BillingEventVerificationError) {
        throw new BadRequestException('Unverifiable request.');
      }
      throw error;
    }
    const outcome = await this.lifecycle.recordAndApply(verified);
    // SC3e-2 — a scheduled complimentary grant on this subscription is
    // settled against the provider's live view (verified, or started once
    // the paid subscription ended). Best effort: the sweep is the backstop.
    if (outcome.status !== 'FAILED') {
      await this.complimentary
        .settleForSubscription(verified.externalSubscriptionId)
        .catch((error: unknown) =>
          this.logger.warn(
            `Complimentary settlement after event failed: ${error instanceof Error ? error.name : 'unknown'}`,
          ),
        );
    }
    if (outcome.status === 'FAILED') {
      // Not durably handled yet: the provider retries.
      throw new ServiceUnavailableException('Try again later.');
    }
    return { received: true };
  }
}
