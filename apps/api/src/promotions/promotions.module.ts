import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { PromotionsAdminService } from './application/promotions-admin.service';
import { PromotionCheckoutService } from './application/promotion-checkout.service';
import { AdminPromotionsController } from './api/admin-promotions.controller';

// Milestone 7E — Promotions & Coupons, the regular merchandise-discount
// system. Entirely separate from Mocha Bean rewards (7C) and Bonus Mocha
// Bean Promotions (7D).
//
//   - PromotionsAdminService: HQ CRUD under `promotions.configure`
//     (CORPORATE-only), audited via InternalAuditService.
//   - PromotionCheckoutService: resolves the applicable regular discount
//     for a cart (best automatic, or a validated coupon) and applies the
//     redemption + concurrency-safe limit enforcement inside the order
//     transaction. Exported so OrdersModule's CheckoutService can use it.
//
// InternalAuthGuard / PermissionGuard come from the @Global
// InternalAuthModule; PrismaService from the @Global PrismaModule.
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AdminPromotionsController],
  providers: [PromotionsAdminService, PromotionCheckoutService],
  exports: [PromotionCheckoutService],
})
export class PromotionsModule {}
