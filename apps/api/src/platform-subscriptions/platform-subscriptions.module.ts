import { Module } from '@nestjs/common';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { PlatformPlansController } from './api/platform-plans.controller';
import { PlatformTenantSubscriptionController } from './api/platform-tenant-subscription.controller';
import { SubscriptionPlansService } from './application/subscription-plans.service';
import { TenantSubscriptionsService } from './application/tenant-subscriptions.service';

// SC2a — CENTERIVO SaaS plans and business subscriptions
// (/api/v1/platform/plans*, /api/v1/platform/tenants/:id/subscription*).
// Platform operators only (PlatformAuthGuard); writes platform data only —
// never a business's own rows. Separate from customer payments.
@Module({
  imports: [PlatformAuthModule, RateLimitModule],
  controllers: [PlatformPlansController, PlatformTenantSubscriptionController],
  providers: [SubscriptionPlansService, TenantSubscriptionsService],
})
export class PlatformSubscriptionsModule {}
