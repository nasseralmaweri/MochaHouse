import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  AdminBillingCheckoutResponse,
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
    return {
      billing,
      canSetUpPayment:
        billing.state === 'AWAITING_SETUP' &&
        request.authorization!.has('billing.manage'),
    };
  }

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
    );
  }
}
