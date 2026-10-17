import { Inject, Injectable } from '@nestjs/common';
import type {
  AdminGettingStartedResponse,
  GettingStartedStep,
} from '@mocha-house/contracts';
import type {
  SingleTenantResolution,
  TenantContext,
} from '@mocha-house/database';
import { SINGLE_TENANT_RESOLUTION } from '../../tenancy/single-tenant-resolution.provider';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import {
  READINESS_LOCATION_SELECT,
  isBillingAuthorized,
  locationReadiness,
} from './location-readiness';

// SC4d — the getting-started checklist (D6), computed from the business's
// real data on every request; there is no progress table to drift. The
// location steps refer to the business's FIRST location (oldest first).
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
  ) {}

  async checklist(
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminGettingStartedResponse> {
    // Business-wide setup: corporate staff only (a location-scoped grant
    // never sees the business's billing or other locations).
    authorization.assertCorporate('locations.view');
    const tenantId = tenant.tenantId;

    const billing = await isBillingAuthorized(this.prisma, tenantId);
    const location = await this.prisma.location.findFirst({
      where: { tenantId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { ...READINESS_LOCATION_SELECT, isDigitalOrderingEnabled: true },
    });
    const readiness = location
      ? await locationReadiness(this.prisma, tenantId, location)
      : null;

    const steps: GettingStartedStep[] = [
      { key: 'business', done: true },
      { key: 'billing', done: billing },
      { key: 'location', done: location !== null },
      { key: 'profile', done: readiness?.profile ?? false },
      { key: 'hours', done: readiness?.hours ?? false },
      { key: 'menu', done: readiness?.menu ?? false },
      { key: 'ordering', done: location?.isDigitalOrderingEnabled ?? false },
    ];
    const completedCount = steps.filter((step) => step.done).length;

    return {
      steps,
      completedCount,
      totalCount: steps.length,
      setupComplete: completedCount === steps.length,
      locationId: location?.id ?? null,
      menuId: readiness?.menuId ?? null,
      // The storefront serves exactly one business per deployment until SC4f.
      storefrontLive: this.storefront.tenantId === tenantId,
    };
  }
}
