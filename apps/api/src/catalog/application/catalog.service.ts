import { Injectable } from '@nestjs/common';
import type {
  CategorySummary,
  MenuSummary,
  ModifierGroupSummary,
  ProductSummary,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';

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
}