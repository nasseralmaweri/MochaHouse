import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AdminUpdateProductRequest } from '@mocha-house/contracts';
import { CatalogService } from '../application/catalog.service';
import { CatalogCreationService } from '../application/catalog-creation.service';
import {
  parseAddMenuProduct,
  parseAssignLocationMenu,
  parseCreateCategory,
  parseCreateMenu,
  parseCreateProduct,
} from '../application/catalog-create-input';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';
import { PermissionGuard } from '../../internal-auth/authorization/permission.guard';
import { RequirePermission } from '../../internal-auth/authorization/require-permission.decorator';
import type { InternalAuthenticatedRequest } from '../../internal-auth/infrastructure/internal-identity';
import type { TenantContext } from '@mocha-house/database';
import { CurrentTenantContext } from '../../tenancy/current-tenant-context.decorator';

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
  constructor(
    private readonly catalogService: CatalogService,
    private readonly catalogCreation: CatalogCreationService,
  ) {}

  // --- Admin catalog creation (S1) ----------------------------------
  // Categories and products are master catalog shared by every location,
  // so creating them needs the CORPORATE-only `catalog.products.edit`;
  // placing a product on a menu changes menu composition, so it needs the
  // CORPORATE-only `catalog.menu.manage`. Bodies are parsed field by field
  // (catalog-create-input.ts) — nothing is spread into Prisma, and any
  // tenant id in the body is ignored.
  @RequirePermission('catalog.view')
  @Get('categories')
  listCategories(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.catalogService.listAdminCategories(
      request.authorization!,
      tenant,
    );
  }

  @RequirePermission('catalog.products.edit')
  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  createCategory(
    @Body() body: unknown,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.catalogCreation.createCategory(
      parseCreateCategory(body),
      request.internalUser!.id,
      request.authorization!,
      tenant,
    );
  }

  @RequirePermission('catalog.products.edit')
  @Post('products')
  @HttpCode(HttpStatus.CREATED)
  createProduct(
    @Body() body: unknown,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.catalogCreation.createProduct(
      parseCreateProduct(body),
      request.internalUser!.id,
      request.authorization!,
      tenant,
    );
  }

  // Idempotent: 201 when the placement is created, 200 when the product was
  // already on the menu (returned unchanged).
  @RequirePermission('catalog.menu.manage')
  @Post('menus/:menuId/products')
  async addProductToMenu(
    @Param('menuId') menuId: string,
    @Body() body: unknown,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.catalogCreation.addProductToMenu(
      menuId,
      parseAddMenuProduct(body),
      request.internalUser!.id,
      request.authorization!,
      tenant,
    );
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
  }

  // --- SC4d — business menus and a location's menu ----------------
  // Both change menu composition for the business, so both need the
  // CORPORATE-only `catalog.menu.manage`. Creating a menu is idempotent by
  // name (201 created, 200 when the business already had it).
  @RequirePermission('catalog.menu.manage')
  @Post('menus')
  async createMenu(
    @Body() body: unknown,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.catalogCreation.createMenu(
      parseCreateMenu(body),
      request.internalUser!.id,
      request.authorization!,
      tenant,
    );
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
  }

  @RequirePermission('catalog.menu.manage')
  @Put('locations/:locationId/menu')
  assignLocationMenu(
    @Param('locationId') locationId: string,
    @Body() body: unknown,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.catalogCreation.assignLocationMenu(
      locationId,
      parseAssignLocationMenu(body),
      request.internalUser!.id,
      request.authorization!,
      tenant,
    );
  }

  // --- Admin master-catalog reads (Milestone 5D-3) -----------------
  // `catalog.view` is CORPORATE-only. The list and detail both include
  // inactive products; the service asserts corporate scope before reading.
  @RequirePermission('catalog.view')
  @Get('products')
  listProducts(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.catalogService.listAdminProducts(
      request.authorization!,
      tenant,
    );
  }

  @RequirePermission('catalog.view')
  @Get('products/:productId')
  getProduct(
    @Param('productId') productId: string,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.catalogService.getAdminProductDetail(
      productId,
      request.authorization!,
      tenant,
    );
  }

  // --- Admin menu reads (Milestone 5D-4) --------------------------
  // `catalog.view` (CORPORATE-only). Both include inactive menus and
  // inactive menu placements — an Admin manages both.
  @RequirePermission('catalog.view')
  @Get('menus')
  listMenus(
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.catalogService.listAdminMenus(request.authorization!, tenant);
  }

  @RequirePermission('catalog.view')
  @Get('menus/:menuId')
  getMenu(
    @Param('menuId') menuId: string,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.catalogService.getAdminMenuDetail(
      menuId,
      request.authorization!,
      tenant,
    );
  }

  // --- Admin location menu / pricing read (Milestone 5D-4) --------
  // `catalog.overrides.manage` (CORPORATE or LOCATION). Resolves the
  // location's assigned menu; the service checks the caller is authorized
  // for this specific location before any read. 404 when the location has
  // no menu.
  @RequirePermission('catalog.overrides.manage')
  @Get('locations/:locationId/menu')
  getLocationMenu(
    @Param('locationId') locationId: string,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.catalogService.getAdminLocationMenu(
      locationId,
      request.authorization!,
      tenant,
    );
  }

  @RequirePermission('catalog.products.edit')
  @Patch('products/:productId')
  updateProduct(
    @Param('productId') productId: string,
    @Body() body: AdminUpdateProductRequest,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
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
      tenant,
    );
  }

  @RequirePermission('catalog.menu.manage')
  @Patch('menus/:menuId/products/:productId/assignment')
  updateMenuProductAssignment(
    @Param('menuId') menuId: string,
    @Param('productId') productId: string,
    @Body() body: UpdateMenuProductAssignmentBody,
    @Req() request: InternalAuthenticatedRequest,
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.catalogService.updateMenuProductAssignment(
      menuId,
      productId,
      body.isActive,
      request.authorization!,
      tenant,
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
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.catalogService.setProductPriceOverride(
      locationId,
      menuId,
      productId,
      body.price,
      request.authorization!,
      tenant,
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
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.catalogService.removeProductPriceOverride(
      locationId,
      menuId,
      productId,
      request.authorization!,
      tenant,
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
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.catalogService.setProductAvailabilityOverride(
      locationId,
      menuId,
      productId,
      body.isAvailable,
      request.authorization!,
      tenant,
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
    @CurrentTenantContext() tenant: TenantContext,
  ) {
    return this.catalogService.removeProductAvailabilityOverride(
      locationId,
      menuId,
      productId,
      request.authorization!,
      tenant,
    );
  }
}
