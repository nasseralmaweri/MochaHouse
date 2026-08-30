import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AdminUpdateProductRequest } from '@mocha-house/contracts';
import { CatalogService } from '../application/catalog.service';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';

interface SetPriceOverrideBody {
  price: number;
}

interface SetAvailabilityOverrideBody {
  isAvailable: boolean;
}

interface UpdateMenuProductAssignmentBody {
  isActive: boolean;
}

// InternalAuthGuard (authentication + ACTIVE) then PermissionGuard
// (Milestone 5B). The security-critical split:
//   - Editing a MASTER product and changing MENU composition affect every
//     location, so they require CORPORATE-scoped permissions
//     (`catalog.products.edit` / `catalog.menu.manage`, both declared
//     CORPORATE-only in the permission catalog). A location-scoped
//     assignment can never satisfy them.
//   - Per-location price/availability OVERRIDES require
//     `catalog.overrides.manage`, valid at CORPORATE or LOCATION scope; the
//     service verifies the caller is authorized for the specific
//     `:locationId` in the path.
@UseGuards(InternalAuthGuard, PermissionGuard)
@Controller('api/v1/admin/catalog')
export class AdminCatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  // --- Admin master-catalog reads (Milestone 5D-3) -----------------
  // `catalog.view` is CORPORATE-only. The list and detail both include
  // inactive products; the service asserts corporate scope before reading.
  @RequirePermission('catalog.view')
  @Get('products')
  listProducts(@Req() request: InternalAuthenticatedRequest) {
    return this.catalogService.listAdminProducts(request.authorization!);
  }

  @RequirePermission('catalog.view')
  @Get('products/:productId')
  getProduct(
    @Param('productId') productId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.catalogService.getAdminProductDetail(
      productId,
      request.authorization!,
    );
  }

  @RequirePermission('catalog.products.edit')
  @Patch('products/:productId')
  updateProduct(
    @Param('productId') productId: string,
    @Body() body: AdminUpdateProductRequest,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    // Explicit fields only — the request body is never spread into the
    // service / Prisma, so `slug`, `categoryId`, `currency` etc. in the
    // payload are inert.
    return this.catalogService.updateProduct(
      productId,
      {
        name: body.name,
        description: body.description,
        basePrice: body.basePrice,
        isActive: body.isActive,
      },
      request.authorization!,
    );
  }

  @RequirePermission('catalog.menu.manage')
  @Patch('menus/:menuId/products/:productId/assignment')
  updateMenuProductAssignment(
    @Param('menuId') menuId: string,
    @Param('productId') productId: string,
    @Body() body: UpdateMenuProductAssignmentBody,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.catalogService.updateMenuProductAssignment(
      menuId,
      productId,
      body.isActive,
      request.authorization!,
    );
  }

  @RequirePermission('catalog.overrides.manage')
  @Put('locations/:locationId/menus/:menuId/products/:productId/price-override')
  setProductPriceOverride(
    @Param('locationId') locationId: string,
    @Param('menuId') menuId: string,
    @Param('productId') productId: string,
    @Body() body: SetPriceOverrideBody,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.catalogService.setProductPriceOverride(
      locationId,
      menuId,
      productId,
      body.price,
      request.authorization!,
    );
  }

  @RequirePermission('catalog.overrides.manage')
  @Delete(
    'locations/:locationId/menus/:menuId/products/:productId/price-override',
  )
  removeProductPriceOverride(
    @Param('locationId') locationId: string,
    @Param('menuId') menuId: string,
    @Param('productId') productId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.catalogService.removeProductPriceOverride(
      locationId,
      menuId,
      productId,
      request.authorization!,
    );
  }

  @RequirePermission('catalog.overrides.manage')
  @Put(
    'locations/:locationId/menus/:menuId/products/:productId/availability-override',
  )
  setProductAvailabilityOverride(
    @Param('locationId') locationId: string,
    @Param('menuId') menuId: string,
    @Param('productId') productId: string,
    @Body() body: SetAvailabilityOverrideBody,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.catalogService.setProductAvailabilityOverride(
      locationId,
      menuId,
      productId,
      body.isAvailable,
      request.authorization!,
    );
  }

  @RequirePermission('catalog.overrides.manage')
  @Delete(
    'locations/:locationId/menus/:menuId/products/:productId/availability-override',
  )
  removeProductAvailabilityOverride(
    @Param('locationId') locationId: string,
    @Param('menuId') menuId: string,
    @Param('productId') productId: string,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return this.catalogService.removeProductAvailabilityOverride(
      locationId,
      menuId,
      productId,
      request.authorization!,
    );
  }
}
