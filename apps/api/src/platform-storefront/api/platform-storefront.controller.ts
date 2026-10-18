import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { PlatformStorefrontView } from '@mocha-house/contracts';
import { PlatformAuthGuard } from '../../platform-auth/infrastructure/platform-auth.guard';
import { RequirePlatformPermission } from '../../platform-auth/authorization/platform-permission.guard';
import type { PlatformAuthenticatedRequest } from '../../platform-auth/infrastructure/platform-identity';
import { assertRecentSignIn } from '../../platform-tenants/application/tenant-lifecycle.service';
import { PlatformTenantQueryError } from '../../platform-tenants/application/platform-tenant-query';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { PlatformStorefrontService } from '../application/platform-storefront.service';
import {
  parseStorefrontAssign,
  parseStorefrontChange,
} from '../application/storefront-publishing-query';

// SC4f-3a (owner decisions H1–H3) — storefront publishing in the Platform
// Console. Every route: an ACTIVE platform operator (PlatformAuthGuard,
// re-read on every request) holding a GRANTED storefront.manage (re-read on
// every request; a refusal is audited). Every change additionally needs a
// recent sign-in, a written reason and the business's slug typed to confirm.
// Business staff and customers never reach these routes, and no
// TenantContext is established for them: :tenantId names the business being
// managed.
@UseGuards(PlatformAuthGuard)
@Controller('api/v1/platform/tenants/:tenantId/storefront')
export class PlatformStorefrontController {
  constructor(private readonly storefront: PlatformStorefrontService) {}

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-onboarding-report')
  @Header('Cache-Control', 'no-store')
  @RequirePlatformPermission('storefront.manage')
  @Get()
  view(@Param('tenantId') tenantId: string): Promise<PlatformStorefrontView> {
    return this.storefront.view(tenantId);
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('storefront.manage')
  @Post('hosts')
  assign(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformStorefrontView> {
    assertRecentSignIn(request.platformIdentity);
    return this.storefront.assign(
      tenantId,
      parsed(() => parseStorefrontAssign(body)),
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('storefront.manage')
  @Post('hosts/:hostId/publish')
  publish(
    @Param('tenantId') tenantId: string,
    @Param('hostId') hostId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformStorefrontView> {
    assertRecentSignIn(request.platformIdentity);
    return this.storefront.publish(
      tenantId,
      hostId,
      parsed(() => parseStorefrontChange(body)),
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('storefront.manage')
  @Post('hosts/:hostId/unpublish')
  unpublish(
    @Param('tenantId') tenantId: string,
    @Param('hostId') hostId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformStorefrontView> {
    assertRecentSignIn(request.platformIdentity);
    return this.storefront.unpublish(
      tenantId,
      hostId,
      parsed(() => parseStorefrontChange(body)),
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
