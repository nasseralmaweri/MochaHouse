import {
  Body,
  Controller,
  Delete,
  Param,
  Patch,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CatalogService } from '../application/catalog.service';
import { InternalAuthGuard } from '../../internal-auth/infrastructure/internal-auth.guard';

interface UpdateProductBody {
  name?: string;
  description?: string | null;
  basePrice?: number | null;
  isActive?: boolean;
}

interface SetPriceOverrideBody {
  price: number;
}

interface SetAvailabilityOverrideBody {
  isAvailable: boolean;
}

interface UpdateMenuProductAssignmentBody {
  isActive: boolean;
}

// Protected by InternalAuthGuard (Milestone 5A) — every route here mutates
// catalog state (product fields, per-location price and availability
// overrides), so it must never be reachable without an ACTIVE internal
// user. No Role/Permission/Scope checks yet (Milestone 5B).
@UseGuards(InternalAuthGuard)
@Controller('api/v1/admin/catalog')
export class AdminCatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Patch('products/:productId')
  updateProduct(
    @Param('productId') productId: string,
    @Body() body: UpdateProductBody,
  ) {
    return this.catalogService.updateProduct(productId, body);
  }

  @Patch('menus/:menuId/products/:productId/assignment')
  updateMenuProductAssignment(
    @Param('menuId') menuId: string,
    @Param('productId') productId: string,
    @Body() body: UpdateMenuProductAssignmentBody,
  ) {
    return this.catalogService.updateMenuProductAssignment(
      menuId,
      productId,
      body.isActive,
    );
  }

  @Put(
    'locations/:locationId/menus/:menuId/products/:productId/price-override',
  )
  setProductPriceOverride(
    @Param('locationId') locationId: string,
    @Param('menuId') menuId: string,
    @Param('productId') productId: string,
    @Body() body: SetPriceOverrideBody,
  ) {
    return this.catalogService.setProductPriceOverride(
      locationId,
      menuId,
      productId,
      body.price,
    );
  }

  @Delete(
    'locations/:locationId/menus/:menuId/products/:productId/price-override',
  )
  removeProductPriceOverride(
    @Param('locationId') locationId: string,
    @Param('menuId') menuId: string,
    @Param('productId') productId: string,
  ) {
    return this.catalogService.removeProductPriceOverride(
      locationId,
      menuId,
      productId,
    );
  }

  @Put(
    'locations/:locationId/menus/:menuId/products/:productId/availability-override',
  )
  setProductAvailabilityOverride(
    @Param('locationId') locationId: string,
    @Param('menuId') menuId: string,
    @Param('productId') productId: string,
    @Body() body: SetAvailabilityOverrideBody,
  ) {
    return this.catalogService.setProductAvailabilityOverride(
      locationId,
      menuId,
      productId,
      body.isAvailable,
    );
  }

  @Delete(
    'locations/:locationId/menus/:menuId/products/:productId/availability-override',
  )
  removeProductAvailabilityOverride(
    @Param('locationId') locationId: string,
    @Param('menuId') menuId: string,
    @Param('productId') productId: string,
  ) {
    return this.catalogService.removeProductAvailabilityOverride(
      locationId,
      menuId,
      productId,
    );
  }
}
