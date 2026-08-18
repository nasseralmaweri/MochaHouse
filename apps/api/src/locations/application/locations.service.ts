import { Injectable } from '@nestjs/common';
import type { LocationMenuResponse } from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.location.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        name: 'asc',
      },
    });
  }

  async findMenu(
    locationId: string,
  ): Promise<LocationMenuResponse | null> {
    const locationMenu = await this.prisma.locationMenu.findFirst({
      where: {
        locationId,
        isActive: true,
        location: {
          isActive: true,
        },
        menu: {
          isActive: true,
        },
      },
      include: {
        location: true,
        menu: {
          include: {
            products: {
              where: {
                isActive: true,
                product: {
                  isActive: true,
                  category: {
                    isActive: true,
                  },
                },
              },
              orderBy: {
                displayOrder: 'asc',
              },
              include: {
                product: {
                  include: {
                    category: true,
                    priceOverrides: {
                      where: {
                        locationId,
                      },
                    },
                    availabilityOverrides: {
                      where: {
                        locationId,
                      },
                    },
                    modifierGroups: {
                      where: {
                        modifierGroup: {
                          isActive: true,
                        },
                      },
                      orderBy: {
                        displayOrder: 'asc',
                      },
                      include: {
                        modifierGroup: {
                          include: {
                            options: {
                              where: {
                                isActive: true,
                              },
                              orderBy: {
                                displayOrder: 'asc',
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!locationMenu) {
      return null;
    }

    return {
      location: {
        id: locationMenu.location.id,
        name: locationMenu.location.name,
        slug: locationMenu.location.slug,
      },
      menu: {
        id: locationMenu.menu.id,
        name: locationMenu.menu.name,
        slug: locationMenu.menu.slug,
        products: locationMenu.menu.products.map((menuProduct) => {
          const priceOverride =
            menuProduct.product.priceOverrides.find(
              (override) => override.menuId === locationMenu.menu.id,
            );

          const availabilityOverride =
            menuProduct.product.availabilityOverrides.find(
              (override) => override.menuId === locationMenu.menu.id,
            );

          return {
            displayOrder: menuProduct.displayOrder,
            effectivePrice:
              priceOverride?.price ?? menuProduct.product.basePrice,
            isAvailable:
              availabilityOverride?.isAvailable ?? true,
            product: {
              id: menuProduct.product.id,
              name: menuProduct.product.name,
              slug: menuProduct.product.slug,
              description: menuProduct.product.description,
              basePrice: menuProduct.product.basePrice,
              currency: menuProduct.product.currency,
              category: {
                id: menuProduct.product.category.id,
                name: menuProduct.product.category.name,
                slug: menuProduct.product.category.slug,
                displayOrder:
                  menuProduct.product.category.displayOrder,
              },
            },
            modifierGroups:
              menuProduct.product.modifierGroups.map(
                (productModifierGroup) => ({
                  id: productModifierGroup.modifierGroup.id,
                  name: productModifierGroup.modifierGroup.name,
                  displayOrder:
                    productModifierGroup.displayOrder,
                  isRequired:
                    productModifierGroup.modifierGroup.isRequired,
                  minSelections:
                    productModifierGroup.modifierGroup.minSelections,
                  maxSelections:
                    productModifierGroup.modifierGroup.maxSelections,
                  options:
                    productModifierGroup.modifierGroup.options.map(
                      (option) => ({
                        id: option.id,
                        name: option.name,
                        priceAdjustment: option.priceAdjustment,
                        displayOrder: option.displayOrder,
                      }),
                    ),
                }),
              ),
          };
        }),
      },
    };
  }
}