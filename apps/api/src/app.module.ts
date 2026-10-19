import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { PaymentModule } from './payment/payment.module';
import { LocationsModule } from './locations/locations.module';
import { CatalogModule } from './catalog/catalog.module';
import { OrdersModule } from './orders/orders.module';
import { CustomerAuthModule } from './customer-auth/customer-auth.module';
import { CustomersModule } from './customers/customers.module';
import { InternalAuthModule } from './internal-auth/internal-auth.module';
import { InternalUsersModule } from './internal-users/internal-users.module';
import { AdminAuditModule } from './admin-audit/admin-audit.module';
import { AdminPlatformModule } from './admin-platform/admin-platform.module';
import { OperationsModule } from './operations/operations.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { PromotionsModule } from './promotions/promotions.module';
import { GiftCardsModule } from './gift-cards/gift-cards.module';
import { CrmModule } from './crm/crm.module';
import { CareersModule } from './careers/careers.module';
import { FranchisingModule } from './franchising/franchising.module';
import { CmsModule } from './cms/cms.module';
import { MediaModule } from './media/media.module';
import { MarketingModule } from './marketing/marketing.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { ReportsModule } from './reports/reports.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PlatformAuthModule } from './platform-auth/platform-auth.module';
import { PlatformTenantsModule } from './platform-tenants/platform-tenants.module';
import { PlatformOnboardingModule } from './platform-onboarding/platform-onboarding.module';
import { PlatformStorefrontModule } from './platform-storefront/platform-storefront.module';
import { PaymentRecoveryModule } from './payment-recovery/payment-recovery.module';
import { PlatformSubscriptionsModule } from './platform-subscriptions/platform-subscriptions.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { SaasBillingModule } from './saas-billing/saas-billing.module';
import { OwnerRegistrationModule } from './owner-registration/owner-registration.module';

@Module({
  imports: [
    PrismaModule,
    // Milestone S0C — validates SINGLE_TENANT_ID at startup and establishes
    // a TenantContext on every request.
    TenancyModule,
    RedisModule,
    // R1 / S3a — tenant-aware rate limiting for the public API.
    RateLimitModule,
    PaymentModule,
    LocationsModule,
    CatalogModule,
    OrdersModule,
    CustomerAuthModule,
    CustomersModule,
    InternalAuthModule,
    InternalUsersModule,
    AdminAuditModule,
    AdminPlatformModule,
    OperationsModule,
    LoyaltyModule,
    PromotionsModule,
    GiftCardsModule,
    CrmModule,
    CareersModule,
    FranchisingModule,
    CmsModule,
    MediaModule,
    MarketingModule,
    ApprovalsModule,
    ReportsModule,
    NotificationsModule,
    SubscriptionsModule,
    SaasBillingModule,
    // SC1a — CENTERIVO platform operators (/api/v1/platform/*), outside
    // every tenant boundary.
    PlatformAuthModule,
    // SC1c — the read-only CENTERIVO tenant registry.
    PlatformTenantsModule,
    PlatformOnboardingModule,
    // SC4f-3a — storefront publishing in the Platform Console.
    PlatformStorefrontModule,
    // ESP-03 PR 5 — payment reconciliation support and automatic recovery
    // (the sweeper is OFF unless PAYMENT_AUTO_RECOVERY_ENABLED=1).
    PaymentRecoveryModule,
    // SC2a — CENTERIVO SaaS plans and business subscriptions.
    PlatformSubscriptionsModule,
    // SC4a — business owner self-service registration (off by default).
    OwnerRegistrationModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
