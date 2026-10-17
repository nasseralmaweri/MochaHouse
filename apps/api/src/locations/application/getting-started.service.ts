import { Inject, Injectable } from '@nestjs/common';
import type { AdminGettingStartedResponse } from '@mocha-house/contracts';
import type {
  SingleTenantResolution,
  TenantContext,
} from '@mocha-house/database';
import { SINGLE_TENANT_RESOLUTION } from '../../tenancy/single-tenant-resolution.provider';
import {
  STOREFRONT_ROUTING_CONFIG,
  type StorefrontRoutingConfig,
} from '../../tenancy/storefront-context';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { onboardingProgress } from './location-readiness';

// SC4d — the getting-started checklist (D6), computed from the business's
// real data on every request; there is no progress table to drift. The
// location steps refer to the business's FIRST location (oldest first). The
// same calculation backs the Platform Console's onboarding progress (SC4e).
//
// "Setup complete" means these steps are done. It does NOT mean the business
// is publicly live or launch-ready: its storefront (SC4f) and the other
// launch requirements are separate, and nothing here publishes anything.
@Injectable()
export class GettingStartedService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SINGLE_TENANT_RESOLUTION)
    private readonly storefront: SingleTenantResolution,
    @Inject(STOREFRONT_ROUTING_CONFIG)
    private readonly routing: StorefrontRoutingConfig,
  ) {}

  async checklist(
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminGettingStartedResponse> {
    // Business-wide setup: corporate staff only (a location-scoped grant
    // never sees the business's billing or other locations).
    authorization.assertCorporate('locations.view');
    const tenantId = tenant.tenantId;
    const progress = (await onboardingProgress(this.prisma, [tenantId])).get(
      tenantId,
    )!;
    return {
      ...progress,
      storefrontLive: await this.storefrontLive(tenantId),
    };
  }

  // Legacy routing: the deployment's storefront serves exactly one business.
  // SC4f-1 host routing: live once any of its approved hostnames is
  // published.
  private async storefrontLive(tenantId: string): Promise<boolean> {
    if (!this.routing.hostRouting) {
      return this.storefront.tenantId === tenantId;
    }
    const published = await this.prisma.storefrontHost.findFirst({
      where: { storefrontTenantId: tenantId, published: true },
      select: { id: true },
    });
    return published !== null;
  }
}
