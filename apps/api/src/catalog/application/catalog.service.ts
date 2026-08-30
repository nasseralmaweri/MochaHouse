import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminLocationMenuProduct,
  AdminLocationMenuResponse,
  AdminMenuDetail,
  AdminMenuProduct,
  AdminMenuSummary,
  AdminProductDetail,
  AdminProductSummary,
  CategorySummary,
  MenuSummary,
  ModifierGroupSummary,
  ProductSummary,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';

interface UpdateProductInput {
  name?: string;
  description?: string | null;
  basePrice?: number | null;
  isActive?: boolean;
}

// The row shape every Admin product read/write returns. `isActive` is
// included (Admin sees inactive products); category is trimmed to identity
// + name (this screen shows nothing else about the category).
const ADMIN_PRODUCT_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  basePrice: true,
  currency: true,
  isActive: true,
  category: { select: { id: true, name: true } },
} as const;

function toAdminProductDetail(row: {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  basePrice: number | null;
  currency: string;
  isActive: boolean;
  category: { id: string; name: string };
}): AdminProductDetail {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    basePrice: row.basePrice,
    currency: row.currency,
    isActive: row.isActive,
    category: { id: row.category.id, name: row.category.name },
  };
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

  // --- Admin master-catalog reads (Milestone 5D-3) -------------------
  // Guarded by InternalAuthGuard + PermissionGuard + `catalog.view` at the
  // controller. `catalog.view` is CORPORATE-only (the product catalog is
  // shared across every location), so this is not the public active-only
  // `findProducts` — it returns inactive products too and is authorization-
  // gated. `assertCorporate` here is the matching service-layer defense.
  async listAdminProducts(
    authorization: AuthorizationContext,
  ): Promise<AdminProductSummary[]> {
    authorization.assertCorporate('catalog.view');

    const products = await this.prisma.product.findMany({
      select: ADMIN_PRODUCT_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });

    return products.map(toAdminProductDetail);
  }

  async getAdminProductDetail(
    productId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminProductDetail> {
    authorization.assertCorporate('catalog.view');

    const detail = await this.loadAdminProductDetail(productId);
    if (!detail) {
      throw new NotFoundException('Product not found.');
    }
    return detail;
  }

  private async loadAdminProductDetail(
    productId: string,
  ): Promise<AdminProductDetail | null> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: ADMIN_PRODUCT_SELECT,
    });
    return product ? toAdminProductDetail(product) : null;
  }

  async updateProduct(
    productId: string,
    input: UpdateProductInput,
    authorization: AuthorizationContext,
  ): Promise<AdminProductDetail> {
    // A master product is global — editing it must be a corporate-scoped
    // capability. PermissionGuard already rejects a caller who lacks
    // `catalog.products.edit` at corporate scope (the permission is
    // CORPORATE-only in the catalog); this is the matching service-layer
    // defense.
    authorization.assertCorporate('catalog.products.edit');

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

    await this.prisma.product.update({
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
    });

    // Never null — existence was just confirmed above.
    return (await this.loadAdminProductDetail(productId))!;
  }

  // --- Admin menu reads (Milestone 5D-4) ---------------------------
  // Guarded by `catalog.view` (CORPORATE-only) at the controller. Includes
  // inactive menus and inactive menu placements — an Admin manages both.
  async listAdminMenus(
    authorization: AuthorizationContext,
  ): Promise<AdminMenuSummary[]> {
    authorization.assertCorporate('catalog.view');

    const menus = await this.prisma.menu.findMany({
      select: { id: true, name: true, slug: true, isActive: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return menus;
  }

  async getAdminMenuDetail(
    menuId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminMenuDetail> {
    authorization.assertCorporate('catalog.view');

    const menu = await this.prisma.menu.findUnique({
      where: { id: menuId },
      include: {
        products: {
          include: { product: { include: { category: true } } },
          orderBy: [{ displayOrder: 'asc' }, { productId: 'asc' }],
        },
      },
    });

    if (!menu) {
      throw new NotFoundException('Menu not found.');
    }

    return {
      id: menu.id,
      name: menu.name,
      slug: menu.slug,
      isActive: menu.isActive,
      products: menu.products.map(
        (placement): AdminMenuProduct => ({
          productId: placement.product.id,
          productName: placement.product.name,
          productIsActive: placement.product.isActive,
          categoryName: placement.product.category.name,
          standardPrice: placement.product.basePrice,
          currency: placement.product.currency,
          shownOnMenu: placement.isActive,
          displayOrder: placement.displayOrder,
        }),
      ),
    };
  }

  // --- Admin location menu / pricing read (Milestone 5D-4) ---------
  // Guarded by `catalog.overrides.manage` (CORPORATE or LOCATION). Resolves
  // the location's assigned menu and, per product, the standard price /
  // availability, any location-specific setting, and the resulting value.
  //
  // The location's single active assigned menu is resolved with findFirst
  // (ordered for determinism) — the SAME assumption the customer effective-
  // menu resolver makes. 5D-4 does not manage menu assignment and does not
  // change this behavior; see the milestone report for the open question of
  // whether more than one active menu per location should ever be allowed.
  async getAdminLocationMenu(
    locationId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminLocationMenuResponse> {
    // Resource-level check BEFORE any read — a caller not authorized for
    // this location gets 403, never a 404 that would leak its existence.
    authorization.assertCanActOnLocation(
      'catalog.overrides.manage',
      locationId,
    );

    const locationMenu = await this.prisma.locationMenu.findFirst({
      where: {
        locationId,
        isActive: true,
        location: { isActive: true },
        menu: { isActive: true },
      },
      orderBy: { menuId: 'asc' },
      include: {
        location: { select: { id: true, name: true } },
        menu: {
          include: {
            products: {
              include: { product: { include: { category: true } } },
              orderBy: [{ displayOrder: 'asc' }, { productId: 'asc' }],
            },
          },
        },
      },
    });

    if (!locationMenu) {
      throw new NotFoundException(
        'This location does not have a menu yet.',
      );
    }

    const menuId = locationMenu.menu.id;
    const [priceRows, availabilityRows] = await Promise.all([
      this.prisma.locationProductPriceOverride.findMany({
        where: { locationId, menuId },
        select: { productId: true, price: true },
      }),
      this.prisma.locationProductAvailabilityOverride.findMany({
        where: { locationId, menuId },
        select: { productId: true, isAvailable: true },
      }),
    ]);
    const priceByProduct = new Map(
      priceRows.map((row) => [row.productId, row.price]),
    );
    const availabilityByProduct = new Map(
      availabilityRows.map((row) => [row.productId, row.isAvailable]),
    );

    return {
      location: {
        id: locationMenu.location.id,
        name: locationMenu.location.name,
      },
      menu: { id: locationMenu.menu.id, name: locationMenu.menu.name },
      products: locationMenu.menu.products.map(
        (placement): AdminLocationMenuProduct => {
          const standardPrice = placement.product.basePrice;
          const locationPrice =
            priceByProduct.get(placement.product.id) ?? null;
          const locationAvailability = availabilityByProduct.has(
            placement.product.id,
          )
            ? availabilityByProduct.get(placement.product.id)!
            : null;
          return {
            productId: placement.product.id,
            productName: placement.product.name,
            productIsActive: placement.product.isActive,
            categoryName: placement.product.category.name,
            currency: placement.product.currency,
            shownOnMenu: placement.isActive,
            standardPrice,
            locationPrice,
            resultingPrice: locationPrice ?? standardPrice,
            locationAvailability,
            resultingAvailability: locationAvailability ?? true,
          };
        },
      ),
    };
  }

  async updateMenuProductAssignment(
    menuId: string,
    productId: string,
    isActive: boolean,
    authorization: AuthorizationContext,
  ) {
    // Menu composition is shared across every location a menu is assigned
    // to — corporate-scoped capability only.
    authorization.assertCorporate('catalog.menu.manage');

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
    authorization: AuthorizationContext,
  ) {
    // A per-location override — a LOCATION-scoped manager may set it for
    // their own location(s); CORPORATE covers any. Checked before any read.
    authorization.assertCanActOnLocation('catalog.overrides.manage', locationId);

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
    authorization: AuthorizationContext,
  ) {
    authorization.assertCanActOnLocation('catalog.overrides.manage', locationId);

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
    authorization: AuthorizationContext,
  ) {
    authorization.assertCanActOnLocation('catalog.overrides.manage', locationId);

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
    authorization: AuthorizationContext,
  ) {
    authorization.assertCanActOnLocation('catalog.overrides.manage', locationId);

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