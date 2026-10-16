import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  isOptionalModuleKey,
  type PlatformSubscriptionChangeResponse,
  type PlatformSubscriptionPreviewResponse,
  type PlatformTenantSubscriptionResponse,
} from '@mocha-house/contracts';
import { PlatformAuthGuard } from '../../platform-auth/infrastructure/platform-auth.guard';
import type { PlatformAuthenticatedRequest } from '../../platform-auth/infrastructure/platform-identity';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { assertRecentSignIn } from '../../platform-tenants/application/tenant-lifecycle.service';
import { isUuid, parseSubscriptionChange } from '../application/plan-input';
import { TenantSubscriptionsService } from '../application/tenant-subscriptions.service';
import { parsed } from './platform-plans.controller';

// SC2a — a business's subscription (platform operators only). Reading and
// previewing change nothing; every change needs a recent sign-in, is rate
// limited and audited.
@UseGuards(PlatformAuthGuard)
@Controller('api/v1/platform/tenants/:tenantId/subscription')
export class PlatformTenantSubscriptionController {
  constructor(private readonly subscriptions: TenantSubscriptionsService) {}

  @Header('Cache-Control', 'no-store')
  @Get()
  read(
    @Param('tenantId') tenantId: string,
  ): Promise<PlatformTenantSubscriptionResponse> {
    return this.subscriptions.get(tenantId);
  }

  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('preview')
  preview(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
  ): Promise<PlatformSubscriptionPreviewResponse> {
    return this.subscriptions.preview(
      tenantId,
      parsed(() => parseSubscriptionChange(body)),
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @Put()
  changePlan(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformSubscriptionChangeResponse> {
    assertRecentSignIn(request.platformIdentity);
    const planVersionId =
      typeof body === 'object' && body !== null
        ? (body as { planVersionId?: unknown }).planVersionId
        : undefined;
    if (!isUuid(planVersionId)) {
      throw new BadRequestException('A valid planVersionId is required.');
    }
    return this.subscriptions.changePlan(
      tenantId,
      planVersionId,
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('add-ons')
  grantAddOn(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformSubscriptionChangeResponse> {
    assertRecentSignIn(request.platformIdentity);
    const moduleKey =
      typeof body === 'object' && body !== null
        ? (body as { moduleKey?: unknown }).moduleKey
        : undefined;
    if (!isOptionalModuleKey(moduleKey)) {
      throw new BadRequestException('A valid optional moduleKey is required.');
    }
    return this.subscriptions.grantAddOn(
      tenantId,
      moduleKey,
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @Delete('add-ons/:moduleKey')
  revokeAddOn(
    @Param('tenantId') tenantId: string,
    @Param('moduleKey') moduleKey: string,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformSubscriptionChangeResponse> {
    assertRecentSignIn(request.platformIdentity);
    if (!isOptionalModuleKey(moduleKey)) {
      throw new BadRequestException('A valid optional moduleKey is required.');
    }
    return this.subscriptions.revokeAddOn(
      tenantId,
      moduleKey,
      request.platformOperator!,
      request.requestId,
    );
  }
}
