import { Controller, Get } from '@nestjs/common';
import { CatalogService } from '../application/catalog.service';

@Controller('api/v1/catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get('categories')
  findCategories() {
    return this.catalogService.findCategories();
  }

  @Get('products')
  findProducts() {
    return this.catalogService.findProducts();
  }

  @Get('menus')
  findMenus() {
    return this.catalogService.findMenus();
  }

  @Get('modifier-groups')
  findModifierGroups() {
    return this.catalogService.findModifierGroups();
  }
}