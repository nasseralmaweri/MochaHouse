import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  PlatformPlan,
  PlatformPlanListResponse,
} from '@mocha-house/contracts';
import { PlatformAuthGuard } from '../../platform-auth/infrastructure/platform-auth.guard';
import type { PlatformAuthenticatedRequest } from '../../platform-auth/infrastructure/platform-identity';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { assertRecentSignIn } from '../../platform-tenants/application/tenant-lifecycle.service';
import {
  PlanInputError,
  parsePlanCreate,
  parseVersionModules,
} from '../application/plan-input';
import { SubscriptionPlansService } from '../application/subscription-plans.service';

// SC2a — CENTERIVO SaaS plans (platform operators only). Every change needs
// a recent sign-in, is rate limited and audited.
export function parsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof PlanInputError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}

@UseGuards(PlatformAuthGuard)
@Controller('api/v1/platform/plans')
export class PlatformPlansController {
  constructor(private readonly plans: SubscriptionPlansService) {}

  @Header('Cache-Control', 'no-store')
  @Get()
  list(): Promise<PlatformPlanListResponse> {
    return this.plans.list();
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @Post()
  create(
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformPlan> {
    assertRecentSignIn(request.platformIdentity);
    return this.plans.create(
      parsed(() => parsePlanCreate(body)),
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @Post(':planId/versions')
  createVersion(
    @Param('planId') planId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformPlan> {
    assertRecentSignIn(request.platformIdentity);
    return this.plans.createVersion(
      planId,
      parsed(() => parseVersionModules(body)),
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @Put(':planId/versions/:versionId')
  updateDraft(
    @Param('planId') planId: string,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformPlan> {
    assertRecentSignIn(request.platformIdentity);
    return this.plans.updateDraft(
      planId,
      versionId,
      parsed(() => parseVersionModules(body)),
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post(':planId/versions/:versionId/publish')
  publish(
    @Param('planId') planId: string,
    @Param('versionId') versionId: string,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformPlan> {
    assertRecentSignIn(request.platformIdentity);
    return this.plans.publish(
      planId,
      versionId,
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post(':planId/versions/:versionId/retire')
  retire(
    @Param('planId') planId: string,
    @Param('versionId') versionId: string,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformPlan> {
    assertRecentSignIn(request.platformIdentity);
    return this.plans.retire(
      planId,
      versionId,
      request.platformOperator!,
      request.requestId,
    );
  }

  // SC4b — offer the plan to owners creating a business themselves.
  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @Put(':planId/self-service')
  setSelfService(
    @Param('planId') planId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformPlan> {
    assertRecentSignIn(request.platformIdentity);
    const available = (body as { available?: unknown } | null)?.available;
    if (typeof available !== 'boolean') {
      throw new BadRequestException('available must be true or false.');
    }
    return this.plans.setSelfService(
      planId,
      available,
      request.platformOperator!,
      request.requestId,
    );
  }
}
