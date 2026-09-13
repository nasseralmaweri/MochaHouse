import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AdminCampaignsController } from './api/admin-campaigns.controller';
import { CampaignsAdminService } from './application/campaigns-admin.service';

// Milestone 8G — Marketing Campaigns, a thin HQ "Campaign Management" layer
// that ORGANIZES existing systems rather than reimplementing them: a
// campaign optionally references one Promotion (7E), one
// LoyaltyBonusPromotion (7D), a MediaAsset (8F, by plain id) and an ordered
// set of Products — it performs no discount or Mocha Beans calculation of
// its own and has zero checkout/runtime behavior.
//
// InternalAuthGuard / PermissionGuard come from the @Global
// InternalAuthModule; PrismaService from the @Global PrismaModule;
// InternalAuditService from AuditModule.
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AdminCampaignsController],
  providers: [CampaignsAdminService],
})
export class MarketingModule {}
