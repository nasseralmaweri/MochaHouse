import { Injectable } from '@nestjs/common';
import type { CategorySummary } from '@mocha-house/contracts';
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
}