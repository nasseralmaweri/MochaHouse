import {
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
import type { PlatformOperatorDirectoryResponse } from '@mocha-house/contracts';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { assertRecentSignIn } from '../../platform-tenants/application/tenant-lifecycle.service';
import { RequirePlatformPermission } from '../authorization/platform-permission.guard';
import { PlatformAuthGuard } from '../infrastructure/platform-auth.guard';
import type { PlatformAuthenticatedRequest } from '../infrastructure/platform-identity';
import {
  PlatformPermissionsService,
  parsePermissionChange,
} from '../application/platform-permissions.service';

// SC3e-3 (owner decision D7) — operator permissions in the console, by an
// operator holding platform.permissions.manage (recent sign-in, a reason;
// never for itself). Read and changed only with that permission.
@UseGuards(PlatformAuthGuard)
@Controller('api/v1/platform')
export class PlatformPermissionsController {
  constructor(private readonly permissions: PlatformPermissionsService) {}

  @RequirePlatformPermission('platform.permissions.manage')
  @Header('Cache-Control', 'no-store')
  @Get('operators')
  directory(): Promise<PlatformOperatorDirectoryResponse> {
    return this.permissions.directory();
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('platform.permissions.manage')
  @Post('operators/:operatorId/permissions')
  grantPermission(
    @Param('operatorId') operatorId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformOperatorDirectoryResponse> {
    assertRecentSignIn(request.platformIdentity);
    return this.permissions.grant(
      operatorId,
      parsePermissionChange(body),
      request.platformOperator!,
      request.requestId,
    );
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-lifecycle')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @RequirePlatformPermission('platform.permissions.manage')
  @Post('operators/:operatorId/permissions/revoke')
  revokePermission(
    @Param('operatorId') operatorId: string,
    @Body() body: unknown,
    @Req() request: PlatformAuthenticatedRequest,
  ): Promise<PlatformOperatorDirectoryResponse> {
    assertRecentSignIn(request.platformIdentity);
    return this.permissions.revoke(
      operatorId,
      parsePermissionChange(body),
      request.platformOperator!,
      request.requestId,
    );
  }
}
