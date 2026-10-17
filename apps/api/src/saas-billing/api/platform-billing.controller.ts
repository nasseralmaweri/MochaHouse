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
  BillingInvoiceListResponse,
  BillingPlanChangePreview,
  PlatformCaseDetailResponse,
  PlatformCaseRecheckResponse,
  PlatformComplimentaryListResponse,
  PlatformComplimentaryView,
  PlatformBillingOverview,
  PlatformBillingEnforcementSweepResponse,
  PlatformBillingPolicy,
  PlatformPlan,
  PlatformReconciliationCaseListResponse,
  PlatformReconciliationRunResponse,
  PlatformTenantBillingResponse,
  PlatformPaymentSetupListResponse,
} from '@mocha-house/contracts';
import { PlatformAuthGuard } from '../../platform-auth/infrastructure/platform-auth.guard';
import { RequirePlatformPermission } from '../../platform-auth/authorization/platform-permission.guard';
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
import { BillingHistoryService } from '../application/billing-history.service';
import {
  BillingComplimentaryService,
  parseGrantRequest,
  parseReasonBody,
} from '../application/billing-complimentary.service';
import {
  BillingCaseActionsService,
  parseCloseRequest,
  parseReleaseRequest,
} from '../application/billing-case-actions.service';
import { BillingReconciliationService } from '../application/billing-reconciliation.service';
import { BillingEnforcementService } from '../application/billing-enforcement.service';
import {
  BillingPlanChangeService,
  parseOperatorPlanChangePreview,
} from '../application/billing-plan-change.service';
import {
  BillingOperationsService,
  parseContactAssignment,
  parseGraceExtension,
} from '../application/billing-operations.service';

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
    private readonly enforcement: BillingEnforcementService,
    private readonly operations: BillingOperationsService,
    private readonly planChanges: BillingPlanChangeService,
    private readonly history: BillingHistoryService,
    private readonly complimentary: BillingComplimentaryService,
    private readonly caseActions: BillingCaseActionsService,
  ) {}

  // --- SC3e-2: complimentary arrangements (owner decisions D2–D4) ---------------

  @Header('Cache-Control', 'no-store')
  @Get('billing/complimentary')
  listComplimentary(): Promise<PlatformComplimentaryListResponse> {
    return this.complimentary.list();
  }

  @Header('Cache-Control', 'no-store')
  @Get('tenants/:tenantId/billing/complimentary')
  getComplimentary(
    @Param('tenantId') tenantId: string,
  ): Promise<PlatformComplimentaryView> {
    return this.complimentary.view(tenantId);
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('billing.complimentary.manage')
  @Post('tenants/:tenantId/billing/complimentary')
  grantComplimentary(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformComplimentaryView> {
    assertRecentSignIn(request.platformIdentity);
    return this.complimentary.grant(
      tenantId,
      parseGrantRequest(body),
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('billing.complimentary.manage')
  @Post('tenants/:tenantId/billing/complimentary/:grantId/withdraw')
  withdrawComplimentary(
    @Param('tenantId') tenantId: string,
    @Param('grantId') grantId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformComplimentaryView> {
    assertRecentSignIn(request.platformIdentity);
    return this.complimentary.withdraw(
      tenantId,
      grantId,
      parseReasonBody(body),
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('billing.complimentary.manage')
  @Post('tenants/:tenantId/billing/complimentary/:grantId/revoke')
  revokeComplimentary(
    @Param('tenantId') tenantId: string,
    @Param('grantId') grantId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformComplimentaryView> {
    assertRecentSignIn(request.platformIdentity);
    return this.complimentary.revoke(
      tenantId,
      grantId,
      parseReasonBody(body),
      request.platformOperator!,
      request.requestId,
    );
  }

  // --- SC3e-2: review-case actions (owner decision D5) ---------------------------

  @Header('Cache-Control', 'no-store')
  @Get('billing/reconciliation-cases/:caseId')
  getCase(
    @Param('caseId') caseId: string,
  ): Promise<PlatformCaseDetailResponse> {
    return this.caseActions.detail(caseId);
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('billing.cases.manage')
  @Post('billing/reconciliation-cases/:caseId/recheck')
  recheckCase(
    @Param('caseId') caseId: string,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformCaseRecheckResponse> {
    return this.caseActions.recheck(
      caseId,
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('billing.schedules.release')
  @Post('billing/reconciliation-cases/:caseId/release-schedule')
  releaseCaseSchedule(
    @Param('caseId') caseId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformCaseDetailResponse> {
    assertRecentSignIn(request.platformIdentity);
    return this.caseActions.releaseSchedule(
      caseId,
      parseReleaseRequest(body),
      request.platformOperator!,
      request.requestId,
    );
  }

  // SC3d-1 — a PREVIEW of a business's plan change on its behalf (nothing
  // charged or changed; audited). SC3d-2 — a recent sign-in and a written
  // reason; an operator never confirms (charges) a change.
  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('billing.accounts.manage')
  @Post('tenants/:tenantId/billing/plan-change/preview')
  previewPlanChange(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<BillingPlanChangePreview> {
    assertRecentSignIn(request.platformIdentity);
    const input = parseOperatorPlanChangePreview(body);
    return this.planChanges.preview(tenantId, input.planPriceId, {
      kind: 'OPERATOR',
      platformOperatorId: request.platformOperator!.id,
      requestReference: request.requestId ?? null,
      reason: input.reason,
    });
  }

  // --- SC3c-3: billing contact, grace extensions, overview ---------------------

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @RequirePlatformPermission('billing.accounts.manage')
  @Put('tenants/:tenantId/billing/contact')
  async assignBillingContact(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformTenantBillingResponse> {
    assertRecentSignIn(request.platformIdentity);
    await this.operations.assignContact(
      tenantId,
      parseContactAssignment(body),
      request.platformOperator!,
      request.requestId,
    );
    return this.accounts.platformView(tenantId);
  }

  // SC3e-4 — businesses that still need payment setup (read-only).
  @Header('Cache-Control', 'no-store')
  @Get('billing/payment-setup')
  paymentSetupList(): Promise<PlatformPaymentSetupListResponse> {
    return this.operations.paymentSetupList();
  }

  // SC3e-4 — extend a payment setup deadline (billing.accounts.manage,
  // recent sign-in, a reason; never past 30 days from the window's start).
  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('billing.accounts.manage')
  @Post('tenants/:tenantId/billing/payment-setup/extension')
  async extendPaymentSetup(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformTenantBillingResponse> {
    assertRecentSignIn(request.platformIdentity);
    await this.operations.extendPaymentSetup(
      tenantId,
      parseGraceExtension(body),
      request.platformOperator!,
      request.requestId,
    );
    return this.accounts.platformView(tenantId);
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('billing.accounts.manage')
  @Post('tenants/:tenantId/billing/grace-extension')
  async extendGrace(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformTenantBillingResponse> {
    assertRecentSignIn(request.platformIdentity);
    await this.operations.extendGrace(
      tenantId,
      parseGraceExtension(body),
      request.platformOperator!,
      request.requestId,
    );
    return this.accounts.platformView(tenantId);
  }

  @Header('Cache-Control', 'no-store')
  @Get('billing/overview')
  billingOverview(): Promise<PlatformBillingOverview> {
    return this.operations.overview();
  }

  // --- SC3b: a business's billing ------------------------------------------

  @Header('Cache-Control', 'no-store')
  @Get('tenants/:tenantId/billing')
  getTenantBilling(
    @Param('tenantId') tenantId: string,
  ): Promise<PlatformTenantBillingResponse> {
    return this.accounts.platformView(tenantId);
  }

  // SC3e-1 — a business's invoices (read-only).
  @Header('Cache-Control', 'no-store')
  @Get('tenants/:tenantId/billing/invoices')
  getTenantInvoices(
    @Param('tenantId') tenantId: string,
    @Query('cursor') cursor: unknown,
  ): Promise<BillingInvoiceListResponse> {
    return this.history.list(tenantId, cursor);
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('billing.accounts.manage')
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
  @RequirePlatformPermission('billing.reconciliation.run')
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

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('billing.reconciliation.run')
  @Post('billing/enforcement/sweep')
  sweepEnforcement(
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformBillingEnforcementSweepResponse> {
    assertRecentSignIn(request.platformIdentity);
    return this.enforcement.sweepNow(
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
  @RequirePlatformPermission('billing.cases.manage')
  @Post('billing/reconciliation-cases/:caseId/resolve')
  async resolveCase(
    @Param('caseId') caseId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<{ resolved: true }> {
    assertRecentSignIn(request.platformIdentity);
    // SC3e-2 — closed with an outcome code and a note.
    await this.caseActions.close(
      caseId,
      parseCloseRequest(body),
      request.platformOperator!,
      request.requestId,
    );
    return { resolved: true };
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @RequirePlatformPermission('billing.prices.manage')
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
  @RequirePlatformPermission('billing.prices.manage')
  @Post('plans/:planId/prices/:priceId/archive')
  async archivePrice(
    @Param('planId') planId: string,
    @Param('priceId') priceId: string,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformPlan> {
    assertRecentSignIn(request.platformIdentity);
    const plan = await this.catalog.archivePrice(
      planId,
      priceId,
      request.platformOperator!,
      request.requestId,
    );
    // SC4c (owner decision C4) — a self-service business still in its first
    // payment setup must choose again: its open Checkout at this price ends.
    await this.accounts.endSelfServiceCheckoutsAtPrice(priceId);
    return plan;
  }

  @Header('Cache-Control', 'no-store')
  @Get('billing/policy')
  getPolicy(): Promise<PlatformBillingPolicy> {
    return this.catalog.getPolicy();
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @RequirePlatformPermission('billing.policy.manage')
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
