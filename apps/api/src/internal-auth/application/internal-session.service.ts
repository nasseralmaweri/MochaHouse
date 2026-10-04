import { Injectable } from '@nestjs/common';
import type {
  InternalMeResponse,
  InternalPermissionCapability,
  InternalPermissionKey,
  LocationSummary,
} from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { InternalUsersService } from './internal-users.service';
import type { InternalUserRow } from '../infrastructure/internal-identity';

// Composes GET /api/v1/internal/me (Milestone 5C): the user profile plus a
// DERIVED authorization summary for the Admin shell. Every value here comes
// from the existing 5B authorization model — this service makes no
// authorization decision and changes none.
@Injectable()
export class InternalSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorizationService: AuthorizationService,
    private readonly internalUsers: InternalUsersService,
  ) {}

  async buildMeResponse(
    user: InternalUserRow,
    tenant: TenantContext,
  ): Promise<InternalMeResponse> {
    const context = await this.authorizationService.loadContext(
      user.id,
      tenant,
    );
    const summary = context.summarize();

    // A CORPORATE user operates on every active location; a LOCATION-scoped
    // user only on the active locations their grants reference. A user with
    // no grants gets no locations. The public /locations endpoint is never
    // consulted — this is the Admin shell's authoritative location source.
    //
    // Milestone S0F — both reads are confined to the request's ACTIVE
    // business: a corporate administrator of Tenant B is offered Tenant B's
    // locations only, so after a business switch the shell can never be
    // handed (or keep) a location from the previous business.
    const locationRows = summary.isCorporate
      ? await this.prisma.location.findMany({
          where: { tenantId: tenant.tenantId, isActive: true },
          orderBy: { name: 'asc' },
        })
      : summary.locationIds.length > 0
        ? await this.prisma.location.findMany({
            where: {
              tenantId: tenant.tenantId,
              id: { in: summary.locationIds },
              isActive: true,
            },
            orderBy: { name: 'asc' },
          })
        : [];

    // Every per-permission locationId is intersected with the active
    // locations the user can actually see, so a capability never references
    // an inactive or invisible location.
    const activeLocationIds = new Set(
      locationRows.map((location) => location.id),
    );

    const capabilities: Partial<
      Record<InternalPermissionKey, InternalPermissionCapability>
    > = {};
    for (const [key, capability] of Object.entries(summary.capabilities)) {
      if (!capability) {
        continue;
      }
      capabilities[key as InternalPermissionKey] = {
        corporate: capability.corporate,
        locationIds: capability.locationIds.filter((id) =>
          activeLocationIds.has(id),
        ),
      };
    }

    // The active business itself (S0F). InternalAuthGuard only builds a
    // member TenantContext for an existing ACTIVE tenant, so it is present.
    const business = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenant.tenantId },
      select: { id: true, name: true, slug: true },
    });

    return {
      business,
      user: this.internalUsers.toProfile(user),
      authorization: {
        permissions: summary.permissions,
        isCorporate: summary.isCorporate,
        locations: locationRows.map(toLocationSummary),
        capabilities,
      },
    };
  }
}

function toLocationSummary(location: {
  id: string;
  name: string;
  slug: string;
  isDigitalOrderingEnabled: boolean;
}): LocationSummary {
  return {
    id: location.id,
    name: location.name,
    slug: location.slug,
    isDigitalOrderingEnabled: location.isDigitalOrderingEnabled,
  };
}
