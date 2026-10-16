import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { InternalMeResponse } from '@mocha-house/contracts';
import type { TenantContext } from '@mocha-house/database';
import { InternalAuthGuard } from '../infrastructure/internal-auth.guard';
import type { InternalAuthenticatedRequest } from '../infrastructure/internal-identity';
import { InternalSessionService } from '../application/internal-session.service';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';
import { AllowDuringBillingWindDown } from '../infrastructure/billing-wind-down.decorator';

// Proves the whole internal boundary end to end: a verified internal
// identity that maps to an ACTIVE Mocha House InternalUser. InternalAuthGuard
// has already rejected every other case (no token, bad token, unknown
// identity, INVITED/SUSPENDED/DISABLED) before this handler runs, so
// request.internalUser is always present and ACTIVE here.
//
// Guarded by InternalAuthGuard ONLY — any ACTIVE internal user may read
// their own session, including one with no role assignments (they get
// permissions: [] / isCorporate: false / locations: []). No PermissionGuard.
@Controller('api/v1/internal')
export class InternalMeController {
  constructor(private readonly session: InternalSessionService) {}

  // SC3c-1 — available during a billing wind-down (the admin shell needs
  // the session; it says which access the person has).
  @AllowDuringBillingWindDown()
  @UseGuards(InternalAuthGuard)
  @Get('me')
  me(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ): Promise<InternalMeResponse> {
    return this.session.buildMeResponse(
      request.internalUser!,
      tenant,
      request.internalBusinessAccess ?? 'FULL',
    );
  }
}
