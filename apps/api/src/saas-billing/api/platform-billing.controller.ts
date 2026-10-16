import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  PlatformBillingPolicy,
  PlatformPlan,
} from '@mocha-house/contracts';
import { PlatformAuthGuard } from '../../platform-auth/infrastructure/platform-auth.guard';
import type { PlatformAuthenticatedRequest } from '../../platform-auth/infrastructure/platform-identity';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { assertRecentSignIn } from '../../platform-tenants/application/tenant-lifecycle.service';
import {
  PriceInputError,
  parseBillingPolicy,
  parsePriceCreate,
} from '../domain/pricing';
import { BillingCatalogService } from '../application/billing-catalog.service';

// SC3a — SaaS list prices and the billing policy (platform operators only).
// Every change needs a recent sign-in, is rate limited and audited. There is
// no billing-provider webhook route yet (SC3b).

function parsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof PriceInputError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}

@UseGuards(PlatformAuthGuard)
@Controller('api/v1/platform')
export class PlatformBillingController {
  constructor(private readonly catalog: BillingCatalogService) {}

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @Post('plans/:planId/prices')
  createPrice(
    @Param('planId') planId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformPlan> {
    assertRecentSignIn(request.platformIdentity);
    return this.catalog.createPrice(
      planId,
      parsed(() => parsePriceCreate(body)),
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('plans/:planId/prices/:priceId/archive')
  archivePrice(
    @Param('planId') planId: string,
    @Param('priceId') priceId: string,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformPlan> {
    assertRecentSignIn(request.platformIdentity);
    return this.catalog.archivePrice(
      planId,
      priceId,
      request.platformOperator!,
      request.requestId,
    );
  }

  @Header('Cache-Control', 'no-store')
  @Get('billing/policy')
  getPolicy(): Promise<PlatformBillingPolicy> {
    return this.catalog.getPolicy();
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @Put('billing/policy')
  updatePolicy(
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformBillingPolicy> {
    assertRecentSignIn(request.platformIdentity);
    return this.catalog.updatePolicy(
      parsed(() => parseBillingPolicy(body)),
      request.platformOperator!,
      request.requestId,
    );
  }
}
