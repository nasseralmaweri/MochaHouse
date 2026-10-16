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
import type {
  PlatformTenantLifecycleResponse,
  PlatformTenantOwnerEmailResponse,
  PlatformTenantStatusChangeResponse,
  PlatformTenantSuspensionReason,
} from '@mocha-house/contracts';
import { PlatformAuthGuard } from '../../platform-auth/infrastructure/platform-auth.guard';
import type { PlatformAuthenticatedRequest } from '../../platform-auth/infrastructure/platform-identity';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { isTenantId } from '../application/platform-tenant-query';
import {
  TenantLifecycleService,
  assertRecentSignIn,
} from '../application/tenant-lifecycle.service';
import {
  TenantProvisionRequestError,
  parseOwnerEmail,
} from '../application/tenant-provision-request';

// SC1e — a business's lifecycle (platform operators only). The reads write
// nothing; every change needs a recent sign-in, is rate limited, and is
// audited (TenantLifecycleService).
const SUSPENSION_REASONS: readonly PlatformTenantSuspensionReason[] = [
  'SECURITY',
  'BILLING',
  'REQUESTED',
];

function body(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

@UseGuards(PlatformAuthGuard)
@Controller('api/v1/platform/tenants/:tenantId')
export class PlatformTenantLifecycleController {
  constructor(private readonly lifecycle: TenantLifecycleService) {}

  @Header('Cache-Control', 'no-store')
  @Get('lifecycle')
  read(
    @Param('tenantId') tenantId: string,
  ): Promise<PlatformTenantLifecycleResponse> {
    return this.lifecycle.lifecycle(tenantId);
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('suspend')
  suspend(
    @Param('tenantId') tenantId: string,
    @Body() raw: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformTenantStatusChangeResponse> {
    assertRecentSignIn(request.platformIdentity);
    const reason = body(raw).reason;
    if (
      typeof reason !== 'string' ||
      !SUSPENSION_REASONS.includes(reason as PlatformTenantSuspensionReason)
    ) {
      throw new BadRequestException(
        'A suspension reason (SECURITY, BILLING or REQUESTED) is required.',
      );
    }
    return this.lifecycle.suspend(
      tenantId,
      reason as PlatformTenantSuspensionReason,
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('reactivate')
  reactivate(
    @Param('tenantId') tenantId: string,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformTenantStatusChangeResponse> {
    assertRecentSignIn(request.platformIdentity);
    return this.lifecycle.reactivate(
      tenantId,
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('owner-email')
  correctOwnerEmail(
    @Param('tenantId') tenantId: string,
    @Body() raw: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformTenantOwnerEmailResponse> {
    assertRecentSignIn(request.platformIdentity);
    const input = body(raw);
    if (typeof input.ownerId !== 'string' || !isTenantId(input.ownerId)) {
      throw new BadRequestException('A valid ownerId is required.');
    }
    let email: string;
    try {
      email = parseOwnerEmail(input.email);
    } catch (error) {
      if (error instanceof TenantProvisionRequestError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    return this.lifecycle.correctOwnerEmail(
      tenantId,
      input.ownerId,
      email,
      request.platformOperator!,
      request.requestId,
    );
  }
}
