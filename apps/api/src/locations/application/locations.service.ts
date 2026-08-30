import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminLocationDetail,
  AdminLocationSummary,
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

  // --- Admin read experience (Milestone 5D-1) -------------------------
  // Guarded by InternalAuthGuard + PermissionGuard + `locations.view` at
  // the controller. This is the Admin-authoritative location read: it must
  // NOT be the public `findAll` (that is unauthenticated and active-only).
  // Scope is resource-level, from the caller's authorization context:
  //   CORPORATE `locations.view` -> every location, active or not.
  //   LOCATION  `locations.view` -> only the granted location ids.
  // PermissionGuard has already proven the permission is held through some
  // valid scope, so `authorizedLocations` is never `none` here; it is still
  // handled defensively.
  async listAdminLocations(
    authorization: AuthorizationContext,
  ): Promise<AdminLocationSummary[]> {
    const authorized = authorization.authorizedLocations('locations.view');

    const where =
      authorized.kind === 'all'
        ? {}
        : authorized.kind === 'locations'
          ? { id: { in: [...authorized.locationIds] } }
          : { id: { in: [] as string[] } };

    const locations = await this.prisma.location.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });

    return locations.map(toAdminLocationSummary);
  }

  async getAdminLocationDetail(
    locationId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminLocationDetail> {
    // Resource-level authorization BEFORE the row is read — a caller not
    // authorized for this location gets 403, never a 404 that would leak
    // whether the id exists.
    authorization.assertCanActOnLocation('locations.view', locationId);

    const detail = await this.loadAdminLocationDetail(locationId);
    if (!detail) {
      throw new NotFoundException('Location not found.');
    }
    return detail;
  }

  // The row read + assigned-menu shaping, without any authorization — every
  // caller here has already asserted scope. Returns null when the id does
  // not exist so callers choose their own 404 message.
  private async loadAdminLocationDetail(
    locationId: string,
  ): Promise<AdminLocationDetail | null> {
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
      include: {
        menus: {
          where: { isActive: true, menu: { isActive: true } },
          orderBy: { menuId: 'asc' },
          include: { menu: true },
        },
      },
    });

    if (!location) {
      return null;
    }

    const activeAssignment = location.menus[0] ?? null;
    let assignedMenu: AdminLocationDetail['assignedMenu'] = null;
    if (activeAssignment) {
      const productCount = await this.prisma.menuProduct.count({
        where: { menuId: activeAssignment.menuId, isActive: true },
      });
      assignedMenu = {
        id: activeAssignment.menu.id,
        name: activeAssignment.menu.name,
        slug: activeAssignment.menu.slug,
        isActive: activeAssignment.menu.isActive,
        productCount,
      };
    }

    return {
      ...toAdminLocationSummary(location),
      assignedMenu,
    };
  }

  // --- Admin minimal edit (Milestone 5D-2) --------------------------
  // PATCH /api/v1/admin/locations/:locationId — CORPORATE-only, guarded by
  // `locations.edit`. Editing a location's identity (its name) or removing
  // it from the platform (isActive) affects every store view, so — like the
  // master-catalog edits — it is a corporate operation and can never be
  // done through a single-location grant. Online ordering is NOT touched
  // here: it has its own control and its own permission
  // (`locations.manage_digital_ordering`), and the two must not be merged.
  async updateLocation(
    locationId: string,
    input: { name?: string; isActive?: boolean },
    authorization: AuthorizationContext,
  ): Promise<AdminLocationDetail> {
    // Matching service-layer defense: PermissionGuard already rejects a
    // caller who does not hold `locations.edit` at corporate scope (the
    // permission is CORPORATE-only in the catalog).
    authorization.assertCorporate('locations.edit');

    const data: { name?: string; isActive?: boolean } = {};

    if (input.name !== undefined) {
      if (
        typeof input.name !== 'string' ||
        input.name.trim().length === 0
      ) {
        throw new BadRequestException('Location name cannot be empty.');
      }
      data.name = input.name.trim();
    }

    if (input.isActive !== undefined) {
      if (typeof input.isActive !== 'boolean') {
        throw new BadRequestException(
          'Location active state must be true or false.',
        );
      }
      data.isActive = input.isActive;
    }

    const existing = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException('Location not found.');
    }

    await this.prisma.location.update({
      where: { id: locationId },
      data,
    });

    // Never null here — we just confirmed the row exists and updated it.
    return (await this.loadAdminLocationDetail(locationId))!;
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

function toAdminLocationSummary(location: {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  isDigitalOrderingEnabled: boolean;
}): AdminLocationSummary {
  return {
    id: location.id,
    name: location.name,
    slug: location.slug,
    isActive: location.isActive,
    isDigitalOrderingEnabled: location.isDigitalOrderingEnabled,
  };
}