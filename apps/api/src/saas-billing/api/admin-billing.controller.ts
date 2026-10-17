import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  AdminInitialPlanOptionsResponse,
  AdminPlanOptionsResponse,
  BillingPlanChangeConfirmResponse,
  BillingPlanChangePreview,
  AdminBillingCheckoutResponse,
  AdminBillingRecoveryResponse,
  AdminBillingResponse,
  AdminBillingPaymentMethodResponse,
  BillingInvoiceListResponse,
} from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import { AllowDuringBillingWindDown } from '../../internal-auth/infrastructure/billing-wind-down.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { BillingAccountService } from '../application/billing-account.service';
import { parseSelfServiceSelection } from '../../platform-subscriptions/application/self-service-plans';
import {
  BillingHistoryService,
  parseInvoiceDocumentRequest,
} from '../application/billing-history.service';
import {
  BillingPlanChangeService,
  parsePlanChangeCancel,
  parsePlanChangeConfirm,
  parsePlanChangePreview,
} from '../application/billing-plan-change.service';

// SC3b — the business's OWN CENTERIVO subscription billing. The business is
// always the authenticated staff member's business (trusted context); the
// request carries no business, price or provider id — and none is read.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/billing')
export class AdminBillingController {
  constructor(
    private readonly accounts: BillingAccountService,
    private readonly planChanges: BillingPlanChangeService,
    private readonly history: BillingHistoryService,
  ) {}

  // SC4c — the plans an owner may choose before the first payment setup, and
  // the current choice (409 when not in the first payment setup).
  @RequirePermission('billing.view')
  @Header('Cache-Control', 'no-store')
  @Get('initial-plan-options')
  initialPlanOptions(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminInitialPlanOptionsResponse> {
    request.authorization!.assertCorporate('billing.view');
    return this.accounts.initialPlanOptions(tenant.tenantId);
  }

  // SC4c (owner decision C3) — change the plan and price before the first
  // payment setup, with the price as shown. billing.manage, business-wide.
  @RequirePermission('billing.manage')
  @UseGuards(RateLimitGuard)
  @RateLimit('billing-checkout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('initial-plan')
  async changeInitialPlan(
    @Body() body: unknown,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminBillingResponse> {
    request.authorization!.assertCorporate('billing.manage');
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException('Choose a plan and a price.');
    }
    await this.accounts.changeInitialSelection(
      tenant.tenantId,
      parseSelfServiceSelection(body as Record<string, unknown>),
    );
    return this.get(request, tenant);
  }

  // SC3d-2 — the prices the business may move to.
  @RequirePermission('billing.view')
  @Header('Cache-Control', 'no-store')
  @Get('plan-options')
  async planOptions(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminPlanOptionsResponse> {
    request.authorization!.assertCorporate('billing.view');
    return { options: await this.planChanges.options(tenant.tenantId) };
  }

  // SC3d-2 — the business CONFIRMS the preview it was shown (the only way a
  // plan change is charged). billing.manage, business-wide; FULL access only.
  @RequirePermission('billing.manage')
  @UseGuards(RateLimitGuard)
  @RateLimit('billing-checkout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('plan-change/confirm')
  async confirmPlanChange(
    @Body() body: unknown,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<BillingPlanChangeConfirmResponse> {
    request.authorization!.assertCorporate('billing.manage');
    return {
      planChange: await this.planChanges.confirm(
        tenant.tenantId,
        parsePlanChangeConfirm(body),
        request.internalUser!.id,
      ),
    };
  }

  // SC3d-3 — the business CANCELS its scheduled change (up to an hour
  // before the date): the provider schedule is released, the subscription
  // untouched. billing.manage, business-wide; FULL access only.
  @RequirePermission('billing.manage')
  @UseGuards(RateLimitGuard)
  @RateLimit('billing-checkout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('plan-change/cancel')
  async cancelPlanChange(
    @Body() body: unknown,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<BillingPlanChangeConfirmResponse> {
    request.authorization!.assertCorporate('billing.manage');
    return {
      planChange: await this.planChanges.cancelScheduled(
        tenant.tenantId,
        parsePlanChangeCancel(body),
        request.internalUser!.id,
      ),
    };
  }

  // SC3d-2 — the provider's page for the waiting plan change's own invoice.
  @RequirePermission('billing.manage')
  @UseGuards(RateLimitGuard)
  @RateLimit('billing-checkout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('plan-change/pay')
  async payPlanChange(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminBillingRecoveryResponse> {
    request.authorization!.assertCorporate('billing.manage');
    return this.planChanges.payLink(tenant.tenantId, request.internalUser!.id);
  }

  // SC3d-1 — a PREVIEW of changing the plan (nothing charged or changed).
  // billing.manage, business-wide; FULL access only (not during a billing
  // wind-down: recover billing first).
  @RequirePermission('billing.manage')
  @UseGuards(RateLimitGuard)
  @RateLimit('billing-checkout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('plan-change/preview')
  async previewPlanChange(
    @Body() body: unknown,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<BillingPlanChangePreview> {
    request.authorization!.assertCorporate('billing.manage');
    return this.planChanges.preview(
      tenant.tenantId,
      parsePlanChangePreview(body),
      { kind: 'STAFF', internalUserId: request.internalUser!.id },
    );
  }

  // SC3e-1 — the business's invoices (billing.view; readable during a
  // billing wind-down, like the billing page).
  @AllowDuringBillingWindDown()
  @RequirePermission('billing.view')
  @Header('Cache-Control', 'no-store')
  @Get('invoices')
  invoices(
    @Query('cursor') cursor: unknown,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<BillingInvoiceListResponse> {
    request.authorization!.assertCorporate('billing.view');
    return this.history.list(tenant.tenantId, cursor);
  }

  // SC3e-1 — the provider's own page or PDF for one of the business's
  // invoices, resolved for this request only.
  @AllowDuringBillingWindDown()
  @RequirePermission('billing.view')
  @UseGuards(RateLimitGuard)
  @RateLimit('billing-checkout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('invoices/:invoiceId/document')
  invoiceDocument(
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminBillingRecoveryResponse> {
    request.authorization!.assertCorporate('billing.view');
    return this.history.documentLink(
      tenant.tenantId,
      invoiceId,
      parseInvoiceDocumentRequest(body),
      request.internalUser!.id,
    );
  }

  // SC3e-1 — what may be shown of the payment method (brand, last four,
  // expiry).
  @AllowDuringBillingWindDown()
  @RequirePermission('billing.view')
  @Header('Cache-Control', 'no-store')
  @Get('payment-method')
  paymentMethod(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminBillingPaymentMethodResponse> {
    request.authorization!.assertCorporate('billing.view');
    return this.history.paymentMethod(tenant.tenantId);
  }

  // SC3c-1 — the billing page stays readable during a billing wind-down.
  @AllowDuringBillingWindDown()
  @RequirePermission('billing.view')
  @Header('Cache-Control', 'no-store')
  @Get()
  async get(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminBillingResponse> {
    request.authorization!.assertCorporate('billing.view');
    const billing = await this.accounts.summaryForTenant(tenant.tenantId);
    if (!billing) throw new NotFoundException('No billing for this business.');
    const manage = request.authorization!.has('billing.manage');
    const actions = this.accounts.recoveryActions(billing);
    // SC4c — a self-service business's first payment setup.
    const initialSetup = billing.initialSetupPending
      ? await this.accounts.initialSetupView(
          tenant.tenantId,
          request.internalUser!.email,
          manage,
        )
      : null;
    return {
      billing,
      // SC4c — never at a plan or price no longer offered (choose again).
      canSetUpPayment:
        billing.state === 'AWAITING_SETUP' &&
        (initialSetup?.selectionAvailable ?? true) &&
        manage,
      canRestartSubscription: actions.restart && manage,
      canPayInvoice: actions.payInvoice && manage,
      canManagePaymentMethod: actions.portal && manage,
      // SC3d-2
      canChangePlan:
        manage &&
        billing.state === 'ACTIVE' &&
        (await this.planChanges.canChange(tenant.tenantId)),
      planChange: await this.planChanges.latest(tenant.tenantId),
      initialSetup,
    };
  }

  // SC3c-1/SC3c-2 — setting up or recovering payment is part of a billing
  // wind-down (billing.manage holders only; never during a SECURITY or
  // administrative suspension, which admits no one).
  @AllowDuringBillingWindDown()
  @RequirePermission('billing.manage')
  @UseGuards(RateLimitGuard)
  @RateLimit('billing-checkout')
  @Header('Cache-Control', 'no-store')
  @Post('checkout')
  async checkout(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminBillingCheckoutResponse> {
    request.authorization!.assertCorporate('billing.manage');
    return this.accounts.openCheckout(
      tenant.tenantId,
      request.internalUser!.email,
      request.internalUser!.id,
    );
  }

  @AllowDuringBillingWindDown()
  @RequirePermission('billing.manage')
  @UseGuards(RateLimitGuard)
  @RateLimit('billing-checkout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('recovery/invoice')
  async payInvoice(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminBillingRecoveryResponse> {
    request.authorization!.assertCorporate('billing.manage');
    return this.accounts.payInvoice(tenant.tenantId, request.internalUser!.id);
  }

  @AllowDuringBillingWindDown()
  @RequirePermission('billing.manage')
  @UseGuards(RateLimitGuard)
  @RateLimit('billing-checkout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('recovery/portal')
  async openPortal(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminBillingRecoveryResponse> {
    request.authorization!.assertCorporate('billing.manage');
    return this.accounts.openPortal(tenant.tenantId, request.internalUser!.id);
  }
}
