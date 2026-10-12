import { Controller, Get } from '@nestjs/common';
import type { TenantContext } from '@mocha-house/database';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';
import { CatalogService } from '../application/catalog.service';

@Controller('api/v1/catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get('categories')
  findCategories(@CurrentTenantContext() tenant: TenantContext) {
    return this.catalogService.findCategories(tenant);
  }

  @Get('products')
  findProducts(@CurrentTenantContext() tenant: TenantContext) {
    return this.catalogService.findProducts(tenant);
  }

  @Get('menus')
  findMenus(@CurrentTenantContext() tenant: TenantContext) {
    return this.catalogService.findMenus(tenant);
  }

  @Get('modifier-groups')
  findModifierGroups(@CurrentTenantContext() tenant: TenantContext) {
    return this.catalogService.findModifierGroups(tenant);
  }
}