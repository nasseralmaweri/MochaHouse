import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  PlatformTenantDetailResponse,
  PlatformTenantListResponse,
  PlatformTenantLocationListResponse,
  PlatformTenantProvisionResponse,
} from '@mocha-house/contracts';
import { PlatformAuthGuard } from '../../platform-auth/infrastructure/platform-auth.guard';
import type { PlatformAuthenticatedRequest } from '../../platform-auth/infrastructure/platform-identity';
import { RateLimit } from '../../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { TenantProvisioningService } from '../application/tenant-provisioning.service';
import {
  TenantProvisionRequestError,
  parseIdempotencyKey,
  parseProvisionRequest,
} from '../application/tenant-provision-request';
import {
  PlatformTenantQueryError,
  parsePaging,
  parseTenantListQuery,
} from '../application/platform-tenant-query';
import { PlatformTenantsService } from '../application/platform-tenants.service';

// SC1c — the CENTERIVO tenant registry (read-only). PlatformAuthGuard is the
// only gate: an ACTIVE platform operator, re-read on every request. No
// tenant-staff or customer credential admits these routes, no TenantContext
// is established for them (PLATFORM_ROUTES). The reads write nothing.
// SC1d — plus POST: provisioning a business (TenantProvisioningService),
// rate limited, with a required Idempotency-Key.
@UseGuards(PlatformAuthGuard)
@Controller('api/v1/platform/tenants')
export class PlatformTenantsController {
  constructor(
    private readonly tenants: PlatformTenantsService,
    private readonly provisioning: TenantProvisioningService,
  ) {}

  @UseGuards(RateLimitGuard)
  @RateLimit('platform-provisioning')
  @Header('Cache-Control', 'no-store')
  @Post()
  async provision(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: PlatformAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PlatformTenantProvisionResponse> {
    const key = provisionParsed(() => parseIdempotencyKey(idempotencyKey));
    const input = provisionParsed(() => parseProvisionRequest(body));
    const result = await this.provisioning.provision(
      input,
      key,
      request.platformOperator!,
      request.requestId,
    );
    // 201 for a new business; 200 for a replay of the same operation.
    response.status(result.replayed ? 200 : 201);
    return result;
  }

  @Header('Cache-Control', 'no-store')
  @Get()
  list(
    @Query() query: Record<string, unknown>,
  ): Promise<PlatformTenantListResponse> {
    return this.tenants.list(parsed(() => parseTenantListQuery(query)));
  }

  @Header('Cache-Control', 'no-store')
  @Get(':tenantId')
  detail(
    @Param('tenantId') tenantId: string,
  ): Promise<PlatformTenantDetailResponse> {
    return this.tenants.detail(tenantId);
  }

  @Header('Cache-Control', 'no-store')
  @Get(':tenantId/locations')
  locations(
    @Param('tenantId') tenantId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<PlatformTenantLocationListResponse> {
    return this.tenants.locations(
      tenantId,
      parsed(() => parsePaging(query)),
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

function provisionParsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof TenantProvisionRequestError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}
