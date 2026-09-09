import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { CustomersModule } from '../customers/customers.module';
import { PaymentModule } from '../payment/payment.module';
import { RedisModule } from '../redis/redis.module';
import { GiftCardsAdminService } from './application/gift-cards-admin.service';
import { GiftCardConfigurationService } from './application/gift-card-configuration.service';
import { GiftCardRedemptionService } from './application/gift-card-redemption.service';
import { GiftCardIssuanceService } from './application/gift-card-issuance.service';
import { GiftCardBalanceService } from './application/gift-card-balance.service';
import { GiftCardPurchaseService } from './application/gift-card-purchase.service';
import { GiftCardPublicThrottleGuard } from './infrastructure/gift-card-public-throttle.guard';
import { AdminGiftCardsController } from './api/admin-gift-cards.controller';
import { GiftCardsController } from './api/gift-cards.controller';

// Gift Cards — the financial + administrative + customer surface for Mocha
// House gift cards.
//
//   - GiftCardIssuanceService (7H): the ONE shared financial issuance core —
//     code generation, canonicalization, HMAC hash, last4, collision retry,
//     GiftCard creation, single ISSUANCE ledger entry — used by both HQ
//     issuance and customer purchase.
//   - GiftCardsAdminService: HQ issue / search / detail / deactivate /
//     reactivate / manual balance correction (7F, CORPORATE-only, audited).
//   - GiftCardConfigurationService: the gift-card purchasing configuration
//     (7F HQ write; 7H public read for the purchase page).
//   - GiftCardRedemptionService (7G): redeem a card as checkout tender.
//   - GiftCardBalanceService (7H): the public balance lookup.
//   - GiftCardPurchaseService (7H): customer digital gift-card purchase —
//     reuses PaymentAttempt + PaymentModule's PaymentProvider, AES-256-GCM
//     temporary code recovery.
//
// PaymentModule provides PAYMENT_PROVIDER without an OrdersModule cycle.
// InternalAuthGuard / PermissionGuard come from @Global InternalAuthModule;
// OptionalCustomerAuthGuard from @Global CustomerAuthModule; RedisService
// from @Global RedisModule; PrismaService from @Global PrismaModule.
@Module({
  imports: [
    PrismaModule,
    AuditModule,
    CustomersModule,
    PaymentModule,
    RedisModule,
  ],
  controllers: [AdminGiftCardsController, GiftCardsController],
  providers: [
    GiftCardIssuanceService,
    GiftCardsAdminService,
    GiftCardConfigurationService,
    GiftCardRedemptionService,
    GiftCardBalanceService,
    GiftCardPurchaseService,
    GiftCardPublicThrottleGuard,
  ],
  exports: [GiftCardRedemptionService],
})
export class GiftCardsModule {}
