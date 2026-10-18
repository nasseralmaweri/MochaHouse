import { Module } from '@nestjs/common';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { PlatformStorefrontController } from './api/platform-storefront.controller';
import { PlatformStorefrontService } from './application/platform-storefront.service';
import {
  STOREFRONT_PUBLISHING_CONFIG,
  storefrontPublishingConfig,
} from './application/storefront-publishing-config';

// SC4f-3a — storefront publishing in the Platform Console. The trusted
// configuration is read once at startup; a malformed value refuses to start.
// STOREFRONT_ROUTING_CONFIG comes from the @Global TenancyModule.
@Module({
  imports: [PlatformAuthModule, RateLimitModule],
  controllers: [PlatformStorefrontController],
  providers: [
    PlatformStorefrontService,
    {
      provide: STOREFRONT_PUBLISHING_CONFIG,
      useFactory: () => storefrontPublishingConfig(),
    },
  ],
})
export class PlatformStorefrontModule {}
