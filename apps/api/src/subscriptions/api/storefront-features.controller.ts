import { Controller, Get, Header } from '@nestjs/common';
import type {
  StorefrontFeaturesResponse,
  StorefrontProfileResponse,
} from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';
import { StorefrontFeaturesService } from '../application/storefront-features.service';
import { StorefrontProfileService } from '../application/storefront-profile.service';

// SC2b — GET /api/v1/storefront/features. No auth: which customer-facing
// features the storefront's OWN business offers, so the web app can hide
// entry points. Availability only — never the plan name, prices or anything
// about another business. The server enforces every feature regardless of
// what the storefront shows.
@Controller('api/v1/storefront')
export class StorefrontFeaturesController {
  constructor(
    private readonly features: StorefrontFeaturesService,
    private readonly profiles: StorefrontProfileService,
  ) {}

  // SC4f-3b — GET /api/v1/storefront/profile: the storefront's own business
  // name, whether it can take orders now, and its loyalty points name.
  @Get('profile')
  @Header('Cache-Control', 'no-store')
  profile(
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<StorefrontProfileResponse> {
    return this.profiles.profile(tenant.tenantId);
  }

  @Get('features')
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<StorefrontFeaturesResponse> {
    return this.features.response(tenant.tenantId);
  }
}
