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
      if (typeof input.name !== 'string' || input.name.trim().length === 0) {
        throw new BadRequestException('Product name cannot be empty.');
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
}