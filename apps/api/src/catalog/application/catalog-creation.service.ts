import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CATALOG_SLUG_MAX_LENGTH,
  slugifyCatalogName,
  type AdminAddMenuProductResponse,
  type AdminCategorySummary,
  type AdminMenuPlacement,
  type AdminProductDetail,
} from '@mocha-house/contracts';
import type { Prisma, TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { hasNulCharacter } from './catalog-create-input';
import type {
  AddMenuProductInput,
  CreateCategoryInput,
  CreateProductInput,
} from './catalog-create-input';

// S1 — Admin catalog creation: categories, products and menu placements.
//
// Every write is for the server-resolved business only (`tenant`), and every
// referenced category / product / menu is looked up within that business
// first — another business's id reads exactly like a missing one. The
// composite (tenantId, id) foreign keys from Security 4C are the database
// backstop for the same rule. Each change and its audit event commit in one
// transaction.
//
// Slugs: an explicit slug that is already taken is a 409. A generated slug
// takes the first free `name`, `name-2`, `name-3`… and, if a concurrent
// request claims it first (unique violation), tries again.
const GENERATED_SLUG_ATTEMPTS = 5;
const SLUG_SUFFIX_ROOM = 6;

@Injectable()
export class CatalogCreationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  async createCategory(
    input: CreateCategoryInput,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminCategorySummary> {
    authorization.assertCorporate('catalog.products.edit');
    const tenantId = tenant.tenantId;

    const category = await this.withUniqueSlug(
      input.slug,
      input.name,
      'category',
      (prefix) => this.takenSlugs('category', tenantId, prefix),
      (slug) =>
        this.prisma.$transaction(async (tx) => {
          const last = await tx.category.aggregate({
            where: { tenantId },
            _max: { displayOrder: true },
          });
          const created = await tx.category.create({
            data: {
              tenantId,
              name: input.name,
              slug,
              isActive: input.isActive,
              displayOrder: (last._max.displayOrder ?? 0) + 1,
            },
          });
          await this.audit.recordCatalogCategoryCreated(tx, {
            actorInternalUserId,
            categoryId: created.id,
            name: created.name,
            slug: created.slug,
            isActive: created.isActive,
          });
          return created;
        }),
      'A category already uses that web address.',
    );

    return {
      id: category.id,
      name: category.name,
      slug: category.slug,
      displayOrder: category.displayOrder,
      isActive: category.isActive,
      productCount: 0,
    };
  }

  async createProduct(
    input: CreateProductInput,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminProductDetail> {
    authorization.assertCorporate('catalog.products.edit');
    const tenantId = tenant.tenantId;

    // Checked before slug allocation so a bad category is a clean 400; it is
    // checked again inside the transaction (and by the composite FK).
    await this.requireCategory(this.prisma, input.categoryId, tenantId);

    const product = await this.withUniqueSlug(
      input.slug,
      input.name,
      'product',
      (prefix) => this.takenSlugs('product', tenantId, prefix),
      (slug) =>
        this.prisma.$transaction(async (tx) => {
          await this.requireCategory(tx, input.categoryId, tenantId);
          const created = await tx.product.create({
            data: {
              tenantId,
              name: input.name,
              slug,
              description: input.description,
              basePrice: input.basePrice,
              isActive: input.isActive,
              categoryId: input.categoryId,
            },
            include: { category: { select: { id: true, name: true } } },
          });
          await this.audit.recordCatalogProductCreated(tx, {
            actorInternalUserId,
            productId: created.id,
            name: created.name,
            slug: created.slug,
            categoryId: created.categoryId,
            basePrice: created.basePrice,
            isActive: created.isActive,
          });
          return created;
        }),
      'A product already uses that web address.',
    );

    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      description: product.description,
      basePrice: product.basePrice,
      currency: product.currency,
      isActive: product.isActive,
      category: { id: product.category.id, name: product.category.name },
    };
  }

  // Idempotent "ensure this product is on this menu". A new placement goes
  // at the end of the menu with the requested visibility; an existing one is
  // returned unchanged (visibility is changed with the assignment PATCH).
  async addProductToMenu(
    menuId: string,
    input: AddMenuProductInput,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<AdminAddMenuProductResponse> {
    authorization.assertCorporate('catalog.menu.manage');
    const tenantId = tenant.tenantId;

    // A menu id from the URL path: a NUL character cannot match any menu (and
    // would otherwise reach the database), so it reads as a missing menu.
    if (hasNulCharacter(menuId)) {
      throw new NotFoundException('Menu not found.');
    }
    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, tenantId },
      select: { id: true },
    });
    if (!menu) {
      throw new NotFoundException('Menu not found.');
    }
    const product = await this.prisma.product.findFirst({
      where: { id: input.productId, tenantId },
      select: { id: true },
    });
    if (!product) {
      throw new BadRequestException('Choose an existing product.');
    }

    const existing = await this.findPlacement(menu.id, product.id);
    if (existing) {
      return { placement: existing, created: false };
    }

    try {
      const placement = await this.prisma.$transaction(async (tx) => {
        const last = await tx.menuProduct.aggregate({
          where: { menuId: menu.id, tenantId },
          _max: { displayOrder: true },
        });
        const created = await tx.menuProduct.create({
          data: {
            tenantId,
            menuId: menu.id,
            productId: product.id,
            displayOrder: (last._max.displayOrder ?? 0) + 1,
            isActive: input.isActive,
          },
          select: PLACEMENT_SELECT,
        });
        await this.audit.recordCatalogMenuProductAdded(tx, {
          actorInternalUserId,
          menuId: created.menuId,
          productId: created.productId,
          displayOrder: created.displayOrder,
          isActive: created.isActive,
        });
        return created;
      });
      return { placement, created: true };
    } catch (error) {
      // A concurrent request added the same placement first: report that
      // placement, exactly as if this request had found it up front.
      if (isUniqueConstraintViolation(error)) {
        const winner = await this.findPlacement(menu.id, product.id);
        if (winner) {
          return { placement: winner, created: false };
        }
      }
      throw error;
    }
  }

  private findPlacement(
    menuId: string,
    productId: string,
  ): Promise<AdminMenuPlacement | null> {
    return this.prisma.menuProduct.findUnique({
      where: { menuId_productId: { menuId, productId } },
      select: PLACEMENT_SELECT,
    });
  }

  private async requireCategory(
    client: Prisma.TransactionClient | PrismaService,
    categoryId: string,
    tenantId: string,
  ): Promise<void> {
    const category = await client.category.findFirst({
      where: { id: categoryId, tenantId },
      select: { id: true },
    });
    if (!category) {
      throw new BadRequestException('Choose an existing category.');
    }
  }

  private async takenSlugs(
    model: 'category' | 'product',
    tenantId: string,
    prefix: string,
  ): Promise<Set<string>> {
    const where = { tenantId, slug: { startsWith: prefix } };
    const rows =
      model === 'category'
        ? await this.prisma.category.findMany({ where, select: { slug: true } })
        : await this.prisma.product.findMany({ where, select: { slug: true } });
    return new Set(rows.map((row) => row.slug));
  }

  private async withUniqueSlug<T>(
    explicitSlug: string | null,
    name: string,
    fallback: string,
    taken: (prefix: string) => Promise<Set<string>>,
    create: (slug: string) => Promise<T>,
    conflictMessage: string,
  ): Promise<T> {
    if (explicitSlug !== null) {
      try {
        return await create(explicitSlug);
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          throw new ConflictException(conflictMessage);
        }
        throw error;
      }
    }

    const base = slugifyCatalogName(name) || fallback;
    for (let attempt = 0; attempt < GENERATED_SLUG_ATTEMPTS; attempt++) {
      // The lookup prefix leaves room for a suffix, so a long base that
      // has to be shortened (see firstFreeSlug) is still covered.
      const prefix = base
        .slice(0, CATALOG_SLUG_MAX_LENGTH - SLUG_SUFFIX_ROOM)
        .replace(/-+$/g, '');
      const slug = firstFreeSlug(base, await taken(prefix));
      try {
        return await create(slug);
      } catch (error) {
        if (!isUniqueConstraintViolation(error)) {
          throw error;
        }
      }
    }
    throw new ConflictException(
      'Could not reserve a unique web address. Please try again.',
    );
  }
}

const PLACEMENT_SELECT = {
  menuId: true,
  productId: true,
  displayOrder: true,
  isActive: true,
} as const;

// `base`, then `base-2`, `base-3`… — shortening `base` when a suffix would
// push the slug past the maximum length.
export function firstFreeSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const stem = base
      .slice(0, CATALOG_SLUG_MAX_LENGTH - suffix.length)
      .replace(/-+$/g, '');
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
