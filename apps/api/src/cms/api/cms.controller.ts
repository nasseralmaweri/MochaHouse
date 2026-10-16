import { Controller, Get, Param } from '@nestjs/common';
import type { TenantContext } from '@mocha-house/database';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';
import { CmsContentPublicService } from '../application/cms-content-public.service';
import { HomeContentPublicService } from '../application/home-content-public.service';
import { StorefrontFeaturesService } from '../../subscriptions/application/storefront-features.service';

// The PUBLIC CMS content API. No authentication.
//   GET /api/v1/content/:pageKey — published content only.
// An unknown key, a key with no row, or a key never published are all 404
// alike; draft content is never reachable here. "home" is resolved to a
// richer response (image URL + full product data, see
// HomeContentPublicService) since its content references other domain
// records by id — every other key returns its content verbatim.
@Controller('api/v1/content')
export class CmsController {
  constructor(
    private readonly content: CmsContentPublicService,
    private readonly homeContent: HomeContentPublicService,
    private readonly features: StorefrontFeaturesService,
  ) {}

  @Get(':pageKey')
  // SC2b — without the website-content module every managed page is 404,
  // exactly like an unpublished one; the storefront falls back to its
  // built-in content. Stored content is untouched and returns on
  // re-entitlement.
  async getPublished(
    @Param('pageKey') pageKey: string,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    await this.features.assertPageAvailable(tenant.tenantId, 'cms');
    if (pageKey === 'home') {
      return this.homeContent.getPublished(tenant);
    }
    return this.content.getPublished(pageKey, tenant);
  }
}
