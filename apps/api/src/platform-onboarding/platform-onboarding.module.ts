import { Module } from '@nestjs/common';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { PlatformOnboardingController } from './api/platform-onboarding.controller';
import { PlatformOnboardingService } from './application/platform-onboarding.service';

// SC4e — onboarding oversight in the Platform Console
// (/api/v1/platform/onboarding*). Imports only the platform boundary
// (PlatformAuthGuard, PlatformPermissionGuard); nothing from the customer or
// business-staff auth modules. PrismaService is @Global. The business
// progress it shows is the SC4d calculation (location-readiness), shared, not
// copied.
@Module({
  imports: [PlatformAuthModule, RateLimitModule],
  controllers: [PlatformOnboardingController],
  providers: [PlatformOnboardingService],
})
export class PlatformOnboardingModule {}
