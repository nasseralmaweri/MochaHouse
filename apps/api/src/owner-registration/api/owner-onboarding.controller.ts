import {
  Body,
  Controller,
  Get,
  Header,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  OwnerBusinessCreateResponse,
  OwnerOnboardingStatus,
} from '@mocha-house/contracts';
import { InternalIdentityGuard } from '../../internal-auth/infrastructure/internal-identity.guard';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import type { TenantContextRequest } from '../../tenancy/tenant-context-request';
import { ownerRegistrationConfig } from '../application/owner-registration.config';
import {
  OwnerOnboardingService,
  parseBusinessCreate,
} from '../application/owner-onboarding.service';

// SC4b — the restricted onboarding surface (owner decision B2): a verified,
// self-registered owner WITHOUT a business, authenticated by their own login
// only (InternalIdentityGuard: no business, no staff row, no permissions,
// no tenant context). These two routes are all it can reach; every
// /api/v1/admin route still needs InternalAuthGuard and a staff row. 404
// unless self-service registration is enabled.
function assertEnabled(): void {
  if (!ownerRegistrationConfig()) throw new NotFoundException();
}

@UseGuards(InternalIdentityGuard)
@Controller('api/v1/internal/onboarding')
export class OwnerOnboardingController {
  constructor(private readonly onboarding: OwnerOnboardingService) {}

  @Header('Cache-Control', 'no-store')
  @Get()
  status(
    @Req() request: InternalAuthenticatedRequest,
  ): Promise<OwnerOnboardingStatus> {
    assertEnabled();
    return this.onboarding.status(request.internalIdentity!);
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('owner-onboarding')
  @Header('Cache-Control', 'no-store')
  @Post('business')
  createBusiness(
    @Body() body: unknown,
    @Req() request: InternalAuthenticatedRequest & TenantContextRequest,
  ): Promise<OwnerBusinessCreateResponse> {
    assertEnabled();
    return this.onboarding.createBusiness(
      request.internalIdentity!,
      parseBusinessCreate(body),
      request.requestId,
    );
  }
}
