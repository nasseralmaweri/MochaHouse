import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { PlatformBillingController } from './api/platform-billing.controller';
import { BillingCatalogService } from './application/billing-catalog.service';
import { BillingLifecycleService } from './application/billing-lifecycle.service';
import { createSaasBillingProvider } from './provider/saas-billing-provider-mode';
import { SAAS_BILLING_PROVIDER } from './provider/saas-billing-provider';

// SC3a — CENTERIVO SaaS subscription billing (charging BUSINESSES for the
// platform). Entirely separate from restaurant/customer payments: it never
// imports PaymentModule, checkout, orders or gift cards, and they never
// import it (saas-billing-separation.spec.ts). Builds on the SC2a plans and
// subscriptions; the provider is the fake or none until SC3b.
@Module({
  imports: [PrismaModule, PlatformAuthModule, RateLimitModule],
  controllers: [PlatformBillingController],
  providers: [
    BillingCatalogService,
    BillingLifecycleService,
    {
      provide: SAAS_BILLING_PROVIDER,
      useFactory: () => createSaasBillingProvider(),
    },
  ],
  exports: [BillingLifecycleService],
})
export class SaasBillingModule {}
