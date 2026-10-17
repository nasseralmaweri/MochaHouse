import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  PlatformOnboardingBusinessListResponse,
  PlatformRegistrationControlView,
  PlatformRegistrationListResponse,
} from '@mocha-house/contracts';
import { PlatformAuthGuard } from '../../platform-auth/infrastructure/platform-auth.guard';
import { RequirePlatformPermission } from '../../platform-auth/authorization/platform-permission.guard';
import type { PlatformAuthenticatedRequest } from '../../platform-auth/infrastructure/platform-identity';
import { assertRecentSignIn } from '../../platform-tenants/application/tenant-lifecycle.service';
import { PlatformTenantQueryError } from '../../platform-tenants/application/platform-tenant-query';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { PlatformOnboardingService } from '../application/platform-onboarding.service';
import {
  parseOnboardingListQuery,
  parseRegistrationControl,
  parseRegistrationListQuery,
} from '../application/platform-onboarding-query';

// SC4e (owner decisions E1–E6) — onboarding oversight in the Platform
// Console. Every route: an ACTIVE platform operator (PlatformAuthGuard,
// re-read on every request) holding a GRANTED permission (re-read on every
// request; a refusal is audited). onboarding.view for the read-only reports;
// onboarding.manage, a recent sign-in and a written reason for pausing or
// resuming new registrations. Business staff and customers never reach these
// routes, and no TenantContext is established for them.
@UseGuards(PlatformAuthGuard)
@Controller('api/v1/platform/onboarding')
export class PlatformOnboardingController {
  constructor(private readonly onboarding: PlatformOnboardingService) {}

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-onboarding-report')
  @Header('Cache-Control', 'no-store')
  @RequirePlatformPermission('onboarding.view')
  @Get('registrations')
  registrations(
    @Query() query: Record<string, unknown>,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformRegistrationListResponse> {
    return this.onboarding.registrations(
      parsed(() => parseRegistrationListQuery(query)),
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-onboarding-report')
  @Header('Cache-Control', 'no-store')
  @RequirePlatformPermission('onboarding.view')
  @Get('businesses')
  businesses(
    @Query() query: Record<string, unknown>,
  ): Promise<PlatformOnboardingBusinessListResponse> {
    return this.onboarding.businesses(
      parsed(() => parseOnboardingListQuery(query)),
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-onboarding-report')
  @Header('Cache-Control', 'no-store')
  @RequirePlatformPermission('onboarding.view')
  @Get('registration-control')
  registrationControl(): Promise<PlatformRegistrationControlView> {
    return this.onboarding.registrationControl();
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('onboarding.manage')
  @Post('registration-control')
  changeRegistrationControl(
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformRegistrationControlView> {
    assertRecentSignIn(request.platformIdentity);
    return this.onboarding.changeRegistrationControl(
      parsed(() => parseRegistrationControl(body)),
      request.platformOperator!,
      request.requestId,
    );
  }
}

function parsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof PlatformTenantQueryError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}
