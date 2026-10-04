import {
  Controller,
  ForbiddenException,
  Get,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { InternalBusinessesResponse } from '@mocha-house/contracts';
import { InternalIdentityGuard } from '../infrastructure/internal-identity.guard';
import type { InternalAuthenticatedRequest } from '../infrastructure/internal-identity';
import { InternalTenantMembershipService } from '../application/internal-tenant-membership.service';

// Milestone S0F — GET /api/v1/internal/businesses: the businesses the
// authenticated internal human may enter, for the future Business switcher.
//
// Guarded by InternalIdentityGuard ONLY: it must work before any business
// is active (a multi-business administrator has to see the list in order
// to choose). It needs no TenantContext and establishes none.
//
// Returns only ACTIVE memberships in ACTIVE tenants, and only safe display
// fields (id / name / slug). An identity that can enter no business gets
// the same generic 403 InternalAuthGuard gives an unknown identity — a
// valid token alone never reveals anything about tenants.
@Controller('api/v1/internal/businesses')
export class InternalBusinessesController {
  constructor(private readonly memberships: InternalTenantMembershipService) {}

  @UseGuards(InternalIdentityGuard)
  @Get()
  async list(
    @Req() request: InternalAuthenticatedRequest,
  ): Promise<InternalBusinessesResponse> {
    const businesses = await this.memberships.listAccessibleBusinesses(
      request.internalIdentity!,
    );
    if (businesses.length === 0) {
      throw new ForbiddenException(
        'This account is not permitted to access the internal area.',
      );
    }
    return { businesses };
  }
}
