import {
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  AdminBillingCheckoutResponse,
  AdminBillingRecoveryResponse,
  AdminBillingResponse,
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

// SC3b — the business's OWN CENTERIVO subscription billing. The business is
// always the authenticated staff member's business (trusted context); the
// request carries no business, price or provider id — and none is read.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/billing')
export class AdminBillingController {
  constructor(private readonly accounts: BillingAccountService) {}

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
    return {
      billing,
      canSetUpPayment: billing.state === 'AWAITING_SETUP' && manage,
      canRestartSubscription: actions.restart && manage,
      canPayInvoice: actions.payInvoice && manage,
      canManagePaymentMethod: actions.portal && manage,
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
