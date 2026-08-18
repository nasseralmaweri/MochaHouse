import { Body, Controller, Param, Patch } from '@nestjs/common';
import { CatalogService } from '../application/catalog.service';

interface UpdateProductBody {
  name?: string;
  description?: string | null;
  basePrice?: number | null;
  isActive?: boolean;
}

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
}