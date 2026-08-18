import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CategorySummary,
  MenuSummary,
  ModifierGroupSummary,
  ProductSummary,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';

interface UpdateProductInput {
  name?: string;
  description?: string | null;
  basePrice?: number | null;
  isActive?: boolean;
}

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  findCategories(): Promise<CategorySummary[]> {
    return this.prisma.category.findMany({
      where: {
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        displayOrder: true,
      },
      orderBy: {
        displayOrder: 'asc',
      },
    });
  }

  findProducts(): Promise<ProductSummary[]> {
    return this.prisma.product.findMany({
      where: {
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        basePrice: true,
        currency: true,
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
            displayOrder: true,
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    });
  }

  findMenus(): Promise<MenuSummary[]> {
    return this.prisma.menu.findMany({
      where: {
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        slug: true,
      },
      orderBy: {
        name: 'asc',
      },
    });
  }

  findModifierGroups(): Promise<ModifierGroupSummary[]> {
    return this.prisma.modifierGroup.findMany({
      where: {
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        displayOrder: true,
        isRequired: true,
        minSelections: true,
        maxSelections: true,
        options: {
          where: {
            isActive: true,
          },
          select: {
            id: true,
            name: true,
            priceAdjustment: true,
            displayOrder: true,
          },
          orderBy: {
            displayOrder: 'asc',
          },
        },
      },
      orderBy: {
        displayOrder: 'asc',
      },
    });
  }

  async updateProduct(
    productId: string,
    input: UpdateProductInput,
  ): Promise<ProductSummary> {
    if (input.name !== undefined) {
      if (
        typeof input.name !== 'string' ||
        input.name.trim().length === 0
      ) {
        throw new BadRequestException(
          'Product name cannot be empty.',
        );
      }
    }

    if (
      input.description !== undefined &&
      input.description !== null &&
      typeof input.description !== 'string'
    ) {
      throw new BadRequestException(
        'Product description must be a string or null.',
      );
    }

    if (input.basePrice !== undefined && input.basePrice !== null) {
      if (
        !Number.isInteger(input.basePrice) ||
        input.basePrice < 0
      ) {
        throw new BadRequestException(
          'Product base price must be a non-negative integer or null.',
        );
      }
    }

    if (
      input.isActive !== undefined &&
      typeof input.isActive !== 'boolean'
    ) {
      throw new BadRequestException(
        'Product active state must be a boolean.',
      );
    }

    const existingProduct = await this.prisma.product.findUnique({
      where: {
        id: productId,
      },
      select: {
        id: true,
      },
    });

    if (!existingProduct) {
      throw new NotFoundException('Product not found.');
    }

    return this.prisma.product.update({
      where: {
        id: productId,
      },
      data: {
        ...(input.name !== undefined
          ? { name: input.name.trim() }
          : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.basePrice !== undefined
          ? { basePrice: input.basePrice }
          : {}),
        ...(input.isActive !== undefined
          ? { isActive: input.isActive }
          : {}),
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        basePrice: true,
        currency: true,
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
            displayOrder: true,
          },
        },
      },
    });
  }

  async updateMenuProductAssignment(
    menuId: string,
    productId: string,
    isActive: boolean,
  ) {
    if (typeof isActive !== 'boolean') {
      throw new BadRequestException(
        'Menu product assignment active state must be a boolean.',
      );
    }

    const menuProduct = await this.prisma.menuProduct.findUnique({
      where: {
        menuId_productId: {
          menuId,
          productId,
        },
      },
      select: {
        menuId: true,
        productId: true,
      },
    });

    if (!menuProduct) {
      throw new NotFoundException(
        'Product is not assigned to this menu.',
      );
    }

    return this.prisma.menuProduct.update({
      where: {
        menuId_productId: {
          menuId,
          productId,
        },
      },
      data: {
        isActive,
      },
      select: {
        menuId: true,
        productId: true,
        displayOrder: true,
        isActive: true,
      },
    });
  }

  async setProductPriceOverride(
    locationId: string,
    menuId: string,
    productId: string,
    price: number,
  ) {
    if (!Number.isInteger(price) || price < 0) {
      throw new BadRequestException(
        'Price override must be a non-negative integer.',
      );
    }

    const [locationMenu, menuProduct] = await Promise.all([
      this.prisma.locationMenu.findUnique({
        where: {
          locationId_menuId: {
            locationId,
            menuId,
          },
        },
        select: {
          locationId: true,
          menuId: true,
        },
      }),
      this.prisma.menuProduct.findUnique({
        where: {
          menuId_productId: {
            menuId,
            productId,
          },
        },
        select: {
          menuId: true,
          productId: true,
        },
      }),
    ]);

    if (!locationMenu) {
      throw new NotFoundException(
        'The selected menu is not assigned to this location.',
      );
    }

    if (!menuProduct) {
      throw new NotFoundException(
        'The selected product is not assigned to this menu.',
      );
    }

    return this.prisma.locationProductPriceOverride.upsert({
      where: {
        locationId_menuId_productId: {
          locationId,
          menuId,
          productId,
        },
      },
      update: {
        price,
      },
      create: {
        locationId,
        menuId,
        productId,
        price,
      },
      select: {
        locationId: true,
        menuId: true,
        productId: true,
        price: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async removeProductPriceOverride(
    locationId: string,
    menuId: string,
    productId: string,
  ) {
    const existingOverride =
      await this.prisma.locationProductPriceOverride.findUnique({
        where: {
          locationId_menuId_productId: {
            locationId,
            menuId,
            productId,
          },
        },
        select: {
          locationId: true,
          menuId: true,
          productId: true,
        },
      });

    if (!existingOverride) {
      throw new NotFoundException('Price override not found.');
    }

    await this.prisma.locationProductPriceOverride.delete({
      where: {
        locationId_menuId_productId: {
          locationId,
          menuId,
          productId,
        },
      },
    });

    return {
      locationId,
      menuId,
      productId,
      inherited: true,
    };
  }

  async setProductAvailabilityOverride(
    locationId: string,
    menuId: string,
    productId: string,
    isAvailable: boolean,
  ) {
    if (typeof isAvailable !== 'boolean') {
      throw new BadRequestException(
        'Availability override must be a boolean.',
      );
    }

    const [locationMenu, menuProduct] = await Promise.all([
      this.prisma.locationMenu.findUnique({
        where: {
          locationId_menuId: {
            locationId,
            menuId,
          },
        },
        select: {
          locationId: true,
          menuId: true,
        },
      }),
      this.prisma.menuProduct.findUnique({
        where: {
          menuId_productId: {
            menuId,
            productId,
          },
        },
        select: {
          menuId: true,
          productId: true,
        },
      }),
    ]);

    if (!locationMenu) {
      throw new NotFoundException(
        'The selected menu is not assigned to this location.',
      );
    }

    if (!menuProduct) {
      throw new NotFoundException(
        'The selected product is not assigned to this menu.',
      );
    }

    return this.prisma.locationProductAvailabilityOverride.upsert({
      where: {
        locationId_menuId_productId: {
          locationId,
          menuId,
          productId,
        },
      },
      update: {
        isAvailable,
      },
      create: {
        locationId,
        menuId,
        productId,
        isAvailable,
      },
      select: {
        locationId: true,
        menuId: true,
        productId: true,
        isAvailable: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async removeProductAvailabilityOverride(
    locationId: string,
    menuId: string,
    productId: string,
  ) {
    const existingOverride =
      await this.prisma.locationProductAvailabilityOverride.findUnique({
        where: {
          locationId_menuId_productId: {
            locationId,
            menuId,
            productId,
          },
        },
        select: {
          locationId: true,
          menuId: true,
          productId: true,
        },
      });

    if (!existingOverride) {
      throw new NotFoundException(
        'Availability override not found.',
      );
    }

    await this.prisma.locationProductAvailabilityOverride.delete({
      where: {
        locationId_menuId_productId: {
          locationId,
          menuId,
          productId,
        },
      },
    });

    return {
      locationId,
      menuId,
      productId,
      inherited: true,
    };
  }
}