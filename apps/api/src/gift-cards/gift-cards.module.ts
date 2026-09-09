import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { GiftCardsAdminService } from './application/gift-cards-admin.service';
import { GiftCardConfigurationService } from './application/gift-card-configuration.service';
import { GiftCardRedemptionService } from './application/gift-card-redemption.service';
import { AdminGiftCardsController } from './api/admin-gift-cards.controller';

// Milestone 7F — Gift Card Foundation & Administration. The financial and
// administrative foundation for Mocha House Gift Cards: a secure gift-card
// instrument, its immutable transaction ledger, its materialized balance,
// and the HQ administration surface. NOT customer purchasing or checkout
// redemption — those are later bounded slices.
//
//   - GiftCardsAdminService: HQ issue / search / detail / deactivate /
//     reactivate / manual balance correction under giftcards.view and
//     giftcards.manage (both CORPORATE-only), audited via
//     InternalAuditService, concurrency-safe via SELECT ... FOR UPDATE.
//   - GiftCardConfigurationService: the company-wide gift-card purchasing
//     configuration under giftcards.configure (CORPORATE-only). Persisted
//     for a future slice; nothing in 7F consumes it.
//   - GiftCardRedemptionService (Milestone 7G): read-only resolution of a
//     supplied code for the checkout quote, and the commit-time write that
//     applies a gift card as tender inside the order-creation transaction.
//     Exported so OrdersModule's CheckoutService can use it.
//
// InternalAuthGuard / PermissionGuard come from the @Global
// InternalAuthModule; PrismaService from the @Global PrismaModule;
// InternalAuditService from AuditModule.
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AdminGiftCardsController],
  providers: [
    GiftCardsAdminService,
    GiftCardConfigurationService,
    GiftCardRedemptionService,
  ],
  exports: [GiftCardRedemptionService],
})
export class GiftCardsModule {}
