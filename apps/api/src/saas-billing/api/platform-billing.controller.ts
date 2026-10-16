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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  PlatformBillingPolicy,
  PlatformPlan,
  PlatformReconciliationCaseListResponse,
  PlatformReconciliationRunResponse,
  PlatformTenantBillingResponse,
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
import { BillingAccountService } from '../application/billing-account.service';
import { BillingReconciliationService } from '../application/billing-reconciliation.service';

// SC3a/SC3b — SaaS list prices, the billing policy, starting a business's
// billing and review-only reconciliation (platform operators only). Every
// change needs a recent sign-in, is rate limited and audited.

function priceIdFrom(body: unknown): string {
  const value =
    typeof body === 'object' && body !== null
      ? (body as { planPriceId?: unknown }).planPriceId
      : undefined;
  const keys =
    typeof body === 'object' && body !== null ? Object.keys(body) : [];
  if (typeof value !== 'string' || keys.length !== 1) {
    throw new BadRequestException('Choose one price (planPriceId).');
  }
  return value;
}

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
  constructor(
    private readonly catalog: BillingCatalogService,
    private readonly accounts: BillingAccountService,
    private readonly reconciliation: BillingReconciliationService,
  ) {}

  // --- SC3b: a business's billing ------------------------------------------

  @Header('Cache-Control', 'no-store')
  @Get('tenants/:tenantId/billing')
  getTenantBilling(
    @Param('tenantId') tenantId: string,
  ): Promise<PlatformTenantBillingResponse> {
    return this.accounts.platformView(tenantId);
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('tenants/:tenantId/billing/start')
  startBilling(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformTenantBillingResponse> {
    assertRecentSignIn(request.platformIdentity);
    return this.accounts.startBilling(
      tenantId,
      priceIdFrom(body),
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('billing/reconcile')
  reconcile(
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformReconciliationRunResponse> {
    assertRecentSignIn(request.platformIdentity);
    return this.reconciliation.run(
      request.platformOperator!,
      request.requestId,
    );
  }

  @Header('Cache-Control', 'no-store')
  @Get('billing/reconciliation-cases')
  listCases(
    @Query('status') status?: string,
  ): Promise<PlatformReconciliationCaseListResponse> {
    return this.reconciliation.list(status);
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('billing/reconciliation-cases/:caseId/resolve')
  async resolveCase(
    @Param('caseId') caseId: string,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<{ resolved: true }> {
    assertRecentSignIn(request.platformIdentity);
    await this.reconciliation.resolve(
      caseId,
      request.platformOperator!,
      request.requestId,
    );
    return { resolved: true };
  }

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
