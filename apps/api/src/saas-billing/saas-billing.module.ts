import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { AuditModule } from '../audit/audit.module';
import { AdminBillingController } from './api/admin-billing.controller';
import { BillingWebhookController } from './api/billing-webhook.controller';
import { PlatformBillingController } from './api/platform-billing.controller';
import { PlatformAdjustmentsController } from './api/platform-adjustments.controller';
import { PlatformRevenueController } from './api/platform-revenue.controller';
import { BillingAccountService } from './application/billing-account.service';
import { BillingCatalogService } from './application/billing-catalog.service';
import { BillingLifecycleService } from './application/billing-lifecycle.service';
import { BillingReconciliationService } from './application/billing-reconciliation.service';
import { BillingEnforcementService } from './application/billing-enforcement.service';
import { BillingOperationsService } from './application/billing-operations.service';
import { BillingPlanChangeService } from './application/billing-plan-change.service';
import { BillingHistoryService } from './application/billing-history.service';
import { BillingComplimentaryService } from './application/billing-complimentary.service';
import { BillingCaseActionsService } from './application/billing-case-actions.service';
import { BillingAdjustmentsService } from './application/billing-adjustments.service';
import { RevenueReportingService } from './application/revenue-reporting.service';
import { PlanChangeMaintenanceService } from './application/plan-change-maintenance.service';
import { createSaasBillingProvider } from './provider/saas-billing-provider-mode';
import { SAAS_BILLING_PROVIDER } from './provider/saas-billing-provider';

// SC3a/SC3b — CENTERIVO SaaS subscription billing (charging BUSINESSES for
// the platform). Entirely separate from restaurant/customer payments: it
// never imports PaymentModule, checkout, orders or gift cards, and they never
// import it (saas-billing-separation.spec.ts). Builds on the SC2a plans and
// subscriptions. The provider is Stripe in TEST MODE, the fake (development
// and tests), or none — never production billing (SC3g).
@Module({
  imports: [
    PrismaModule,
    PlatformAuthModule,
    InternalAuthModule,
    RateLimitModule,
    AuditModule,
  ],
  controllers: [
    PlatformBillingController,
    PlatformAdjustmentsController,
    PlatformRevenueController,
    AdminBillingController,
    BillingWebhookController,
  ],
  providers: [
    BillingCatalogService,
    BillingLifecycleService,
    BillingAccountService,
    BillingReconciliationService,
    BillingEnforcementService,
    BillingOperationsService,
    BillingPlanChangeService,
    BillingHistoryService,
    BillingComplimentaryService,
    BillingCaseActionsService,
    BillingAdjustmentsService,
    RevenueReportingService,
    PlanChangeMaintenanceService,
    {
      provide: SAAS_BILLING_PROVIDER,
      useFactory: () => createSaasBillingProvider(),
    },
  ],
  exports: [BillingLifecycleService],
})
export class SaasBillingModule {}
