import {
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  AdminPaymentAccountResponse,
  AdminPaymentOnboardingResponse,
} from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { PaymentAccountsService } from '../application/payment-accounts.service';

// ESP-04 M1 — Admin > Payments: the restaurant's OWN Stripe account for
// customer payments (never CENTERIVO's subscription billing). Owner only:
// payments.connect (guard + corporate scope) AND the business's built-in
// administrator role (service). The request carries nothing: the business,
// the account and the return page all come from our own records and
// configuration.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/payments')
export class AdminPaymentsController {
  constructor(private readonly accounts: PaymentAccountsService) {}

  @RequirePermission('payments.connect')
  @Header('Cache-Control', 'no-store')
  @Get('account')
  async account(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminPaymentAccountResponse> {
    await this.owner(request, tenant);
    return this.accounts.account(tenant.tenantId);
  }

  // Connect (or continue setting up) the restaurant's Stripe account: the
  // owner is sent to Stripe's hosted onboarding.
  @RequirePermission('payments.connect')
  @UseGuards(RateLimitGuard)
  @RateLimit('payments-onboarding')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('account/onboarding')
  async onboarding(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminPaymentOnboardingResponse> {
    await this.owner(request, tenant);
    return this.accounts.startOnboarding(
      tenant.tenantId,
      request.internalUser!.id,
    );
  }

  // Read the account back from Stripe now (e.g. on returning from
  // onboarding — the return itself proves nothing).
  @RequirePermission('payments.connect')
  @UseGuards(RateLimitGuard)
  @RateLimit('payments-onboarding')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('account/refresh')
  async refresh(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<AdminPaymentAccountResponse> {
    await this.owner(request, tenant);
    return this.accounts.refresh(tenant.tenantId);
  }

  private async owner(
    request: InternalAuthenticatedRequest,
    tenant: TenantContext,
  ): Promise<void> {
    request.authorization!.assertCorporate('payments.connect');
    await this.accounts.assertOwner(tenant.tenantId, request.internalUser!.id);
  }
}
