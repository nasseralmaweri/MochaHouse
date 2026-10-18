import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { StorefrontFeaturesController } from './api/storefront-features.controller';
import { EntitlementsService } from './application/entitlements.service';
import { StorefrontFeaturesService } from './application/storefront-features.service';
import { StorefrontProfileService } from './application/storefront-profile.service';

// SC2b — customer-facing entitlements. Imported by every module whose
// public routes, checkout steps or customer reads depend on an optional
// module. (InternalAuthModule keeps its own EntitlementsService for the
// staff API — it is stateless, so the two instances always agree.)
@Module({
  imports: [PrismaModule, TenancyModule],
  controllers: [StorefrontFeaturesController],
  providers: [
    EntitlementsService,
    StorefrontFeaturesService,
    StorefrontProfileService,
  ],
  exports: [StorefrontFeaturesService],
})
export class SubscriptionsModule {}
