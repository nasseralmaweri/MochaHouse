import { Controller, Get, Param } from '@nestjs/common';
import type { TenantContext } from '@mocha-house/database';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';
import { LocationsService } from '../application/locations.service';

@Controller('api/v1/locations')
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Get()
  findAll(@CurrentTenantContext() tenant: TenantContext) {
    return this.locationsService.findAll(tenant);
  }

  @Get(':locationId/menu')
  findMenu(
    @Param('locationId') locationId: string,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.locationsService.findMenu(locationId, tenant.tenantId);
  }
}