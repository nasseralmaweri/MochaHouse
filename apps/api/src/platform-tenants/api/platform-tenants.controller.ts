import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  PlatformTenantDetailResponse,
  PlatformTenantListResponse,
  PlatformTenantLocationListResponse,
} from '@mocha-house/contracts';
import { PlatformAuthGuard } from '../../platform-auth/infrastructure/platform-auth.guard';
import {
  PlatformTenantQueryError,
  parsePaging,
  parseTenantListQuery,
} from '../application/platform-tenant-query';
import { PlatformTenantsService } from '../application/platform-tenants.service';

// SC1c — the CENTERIVO tenant registry (read-only). PlatformAuthGuard is the
// only gate: an ACTIVE platform operator, re-read on every request. No
// tenant-staff or customer credential admits these routes, no TenantContext
// is established for them (PLATFORM_ROUTES), and nothing here writes.
@UseGuards(PlatformAuthGuard)
@Controller('api/v1/platform/tenants')
export class PlatformTenantsController {
  constructor(private readonly tenants: PlatformTenantsService) {}

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
