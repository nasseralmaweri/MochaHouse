import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  LocationMenuResponse,
  LocationSummary,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import type { Prisma } from '@mocha-house/database';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';

// Same shape PrismaService and a $transaction callback both satisfy, for
// the query methods below that checkout re-runs inside a protected
// transaction rather than against the ambient client.
type PrismaClientLike = PrismaService | Prisma.TransactionClient;

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<LocationSummary[]> {
    const locations = await this.prisma.location.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        name: 'asc',
      },
    });

    return locations.map((location) => ({
      id: location.id,
      name: location.name,
      slug: location.slug,
      isDigitalOrderingEnabled: location.isDigitalOrderingEnabled,
    }));
  }

  async findMenu(
    locationId: string,
    client: PrismaClientLike = this.prisma,
  ): Promise<LocationMenuResponse | null> {
    const locationMenu = await client.locationMenu.findFirst({
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
        isDigitalOrderingEnabled:
          locationMenu.location.isDigitalOrderingEnabled,
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

  async updateDigitalOrdering(
    locationId: string,
    isDigitalOrderingEnabled: boolean,
    authorization: AuthorizationContext,
  ): Promise<LocationSummary> {
    if (typeof isDigitalOrderingEnabled !== 'boolean') {
      throw new BadRequestException(
        'Digital ordering state must be a boolean.',
      );
    }
    // Authorized for THIS location (CORPORATE covers all; LOCATION only an
    // assigned one) before the location is read or written.
    authorization.assertCanActOnLocation(
      'locations.manage_digital_ordering',
      locationId,
    );

    const existingLocation = await this.prisma.location.findUnique({
      where: {
        id: locationId,
      },
      select: {
        id: true,
      },
    });

    if (!existingLocation) {
      throw new NotFoundException('Location not found.');
    }

    return this.prisma.location.update({
      where: {
        id: locationId,
      },
      data: {
        isDigitalOrderingEnabled,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        isDigitalOrderingEnabled: true,
      },
    });
  }
}