import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { CustomersModule } from '../customers/customers.module';
import { LoyaltyService } from './application/loyalty.service';
import { LoyaltyAdminService } from './application/loyalty-admin.service';
import { LoyaltySettingsService } from './application/loyalty-settings.service';
import { LoyaltyRewardsService } from './application/loyalty-rewards.service';
import { LoyaltyRedemptionService } from './application/loyalty-redemption.service';
import { CustomerLoyaltyController } from './api/customer-loyalty.controller';
import { AdminLoyaltyController } from './api/admin-loyalty.controller';

// Mocha Beans:
//   - Milestone 7A: the earning path (LoyaltyService, used by OrdersModule's
//     checkout), the authenticated customer balance read, and the HQ
//     add/deduct surface (LoyaltyAdminService).
//   - Milestone 7B: HQ configuration of the company-wide earning rate
//     (LoyaltySettingsService) and the customer Rewards Catalog
//     (LoyaltyRewardsService). Catalog management only — no redemption.
//
// InternalAuthGuard / PermissionGuard / AuthorizationService come from the
// @Global InternalAuthModule; CustomerAuthGuard from the @Global
// CustomerAuthModule; PrismaService from the @Global PrismaModule.
// CustomersModule provides CustomersService; AuditModule provides
// InternalAuditService (the sensitive-action audit written alongside every
// manual adjustment, earning-rate change and reward mutation).
@Module({
  imports: [PrismaModule, AuditModule, CustomersModule],
  controllers: [CustomerLoyaltyController, AdminLoyaltyController],
  providers: [
    LoyaltyService,
    LoyaltyAdminService,
    LoyaltySettingsService,
    LoyaltyRewardsService,
    LoyaltyRedemptionService,
  ],
  // Exported so OrdersModule's CheckoutService can earn Beans and apply a
  // reward redemption inside the order-creation transaction, and the
  // checkout reward-eligibility endpoint can quote a cart.
  exports: [LoyaltyService, LoyaltyRedemptionService],
})
export class LoyaltyModule {}
