import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { SubmitFranchiseInquiryRequest } from '@mocha-house/contracts';
import { FranchiseInquiriesPublicService } from '../application/franchise-inquiries-public.service';
import { FranchisingPublicThrottleGuard } from '../infrastructure/franchising-public-throttle.guard';

// The PUBLIC Franchising API. No authentication.
//   POST /api/v1/franchising/inquiries — submit a franchise inquiry.
// Carries a minimal ~5/min/IP Redis throttle
// (FranchisingPublicThrottleGuard, fail-open). There is NO public GET for
// inquiries and no id is returned on submit.
@Controller('api/v1/franchising')
export class FranchisingController {
  constructor(private readonly inquiries: FranchiseInquiriesPublicService) {}

  @UseGuards(FranchisingPublicThrottleGuard)
  @Post('inquiries')
  submit(@Body() body: SubmitFranchiseInquiryRequest) {
    return this.inquiries.submit(body);
  }
}
