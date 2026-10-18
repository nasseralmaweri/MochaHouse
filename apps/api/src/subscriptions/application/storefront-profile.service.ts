import { Inject, Injectable } from '@nestjs/common';
import type { StorefrontProfileResponse } from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { businessDisplayName } from '../../tenancy/business-name';
import { LEGACY_BRAND, type LegacyBrand } from '../../tenancy/legacy-brand';
import { effectivePointsLabel } from '../../loyalty/application/loyalty-points-label';
import { StorefrontFeaturesService } from './storefront-features.service';

// SC4f-3b (owner decision J1) — what a storefront needs to present its OWN
// business: its name, whether it can take orders now, and its loyalty points
// name. The business is the request's server-resolved TenantContext (host
// routing or the deployment's single business) — never anything the browser
// sends — and a suspended business never gets here (the tenant middleware
// answers 503 first). Public information only; the server still enforces
// every ordering, billing and entitlement rule at checkout.
@Injectable()
export class StorefrontProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly features: StorefrontFeaturesService,
    @Inject(LEGACY_BRAND) private readonly legacyBrand: LegacyBrand,
  ) {}

  async profile(tenantId: string): Promise<StorefrontProfileResponse> {
    const [businessName, checkout, orderingLocation, loyaltyPointsLabel] =
      await Promise.all([
        businessDisplayName(this.prisma, tenantId),
        this.features.forCheckout(tenantId),
        this.prisma.location.findFirst({
          where: { tenantId, isActive: true, isDigitalOrderingEnabled: true },
          select: { id: true },
        }),
        effectivePointsLabel(this.prisma, tenantId, this.legacyBrand),
      ]);
    return {
      businessName,
      orderingAvailable: checkout.salesOpen && orderingLocation !== null,
      loyaltyPointsLabel,
      presentation: this.legacyBrand.isLegacy(tenantId) ? 'legacy' : 'standard',
    };
  }
}
