import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { SubmitFranchiseInquiryRequest } from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';
import { FranchiseInquiriesPublicService } from '../application/franchise-inquiries-public.service';
import { FranchisingPublicThrottleGuard } from '../infrastructure/franchising-public-throttle.guard';
import { StorefrontFeaturesService } from '../../subscriptions/application/storefront-features.service';

// The PUBLIC Franchising API. No authentication.
//   POST /api/v1/franchising/inquiries — submit a franchise inquiry.
// Carries a minimal ~5/min/IP Redis throttle
// (FranchisingPublicThrottleGuard, fail-open). There is NO public GET for
// inquiries and no id is returned on submit.
@Controller('api/v1/franchising')
export class FranchisingController {
  constructor(
    private readonly inquiries: FranchiseInquiriesPublicService,
    private readonly features: StorefrontFeaturesService,
  ) {}

  @UseGuards(FranchisingPublicThrottleGuard)
  @Post('inquiries')
  // SC2b — refused (403) before anything is stored or queued when the
  // franchising module is not in the business's plan.
  async submit(
    @Body() body: SubmitFranchiseInquiryRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    await this.features.assertAvailable(tenant.tenantId, 'franchising');
    return this.inquiries.submit(body, tenant);
  }
}
