import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminPromotion,
  AdminPromotionOptions,
  AdminPromotionsResponse,
  CreatePromotionRequest,
  PromotionApplicability,
  PromotionDiscountType,
  PromotionKind,
  UpdatePromotionRequest,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { normalizeCouponCode } from './coupon-code';

// HQ management of Promotions & Coupons (Milestone 7E). `promotions.configure`
// is CORPORATE-only in the permission catalog — PermissionGuard rejects a
// LOCATION grant and every method here also calls `assertCorporate`.
// Deliberately bounded: three discount types, three applicability modes,
// all-or-selected locations, an optional flat date window, optional minimum
// purchase, optional redemption limits. Promotions are never hard-deleted
// (isActive is the off switch). `kind` and `discountType` are fixed at
// creation.

const NAME_MAX_LENGTH = 120;
const DESCRIPTION_MAX_LENGTH = 500;
const FIXED_AMOUNT_MAX = 1_000_000; // $10,000
const MINIMUM_SUBTOTAL_MAX = 10_000_000;
const MAX_DISCOUNT_MAX = 1_000_000;
const TOTAL_LIMIT_MAX = 100_000_000;
const PER_CUSTOMER_LIMIT_MAX = 100_000;

type PromotionWithTargets = Prisma.PromotionGetPayload<{
  include: {
    eligibleProducts: { include: { product: { select: { id: true; name: true } } } };
    eligibleCategories: {
      include: { category: { select: { id: true; name: true } } };
    };
    eligibleLocations: {
      include: { location: { select: { id: true; name: true } } };
    };
  };
}>;

const PROMOTION_INCLUDE = {
  eligibleProducts: {
    include: { product: { select: { id: true, name: true } } },
    orderBy: { productId: 'asc' },
  },
  eligibleCategories: {
    include: { category: { select: { id: true, name: true } } },
    orderBy: { categoryId: 'asc' },
  },
  eligibleLocations: {
    include: { location: { select: { id: true, name: true } } },
    orderBy: { locationId: 'asc' },
  },
} satisfies Prisma.PromotionInclude;

const PROMOTION_ORDER_BY: Prisma.PromotionOrderByWithRelationInput[] = [
  { createdAt: 'asc' },
  { id: 'asc' },
];

@Injectable()
export class PromotionsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  async listPromotions(
    authorization: AuthorizationContext,
  ): Promise<AdminPromotionsResponse> {
    authorization.assertCorporate('promotions.configure');
    const promotions = await this.prisma.promotion.findMany({
      include: PROMOTION_INCLUDE,
      orderBy: PROMOTION_ORDER_BY,
    });
    return { promotions: promotions.map((p) => this.toAdminPromotion(p)) };
  }

  async getOptions(
    authorization: AuthorizationContext,
  ): Promise<AdminPromotionOptions> {
    authorization.assertCorporate('promotions.configure');
    const [products, categories, locations] = await Promise.all([
      this.prisma.product.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.category.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { displayOrder: 'asc' },
      }),
      this.prisma.location.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return { products, categories, locations };
  }

  async createPromotion(
    request: CreatePromotionRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminPromotion> {
    authorization.assertCorporate('promotions.configure');

    const name = this.validateName(request?.name);
    const description = this.validateDescription(request?.description);
    const kind = this.validateKind(request?.kind);
    const discountType = this.validateDiscountType(request?.discountType);
    const code = this.validateCode(request?.code, kind);
    const applicability = this.validateApplicability(
      request?.applicability,
      discountType,
    );
    const productIds = this.normalizeIdList(request?.eligibleProductIds);
    const categoryIds = this.normalizeIdList(request?.eligibleCategoryIds);
    this.assertApplicabilityTargets(
      applicability,
      discountType,
      productIds,
      categoryIds,
    );
    const { discountValue, maxDiscountMinorUnits } = this.validateDiscountValue(
      discountType,
      request?.discountValue,
      request?.maxDiscountMinorUnits,
    );
    const minimumSubtotalMinorUnits = this.validateOptionalMinorUnits(
      request?.minimumSubtotalMinorUnits,
      'minimum purchase',
      0,
      MINIMUM_SUBTOTAL_MAX,
    );
    const { appliesToAllLocations, locationIds } = this.validateLocations(
      request?.appliesToAllLocations,
      request?.eligibleLocationIds,
    );
    const { startsAt, endsAt } = this.validateWindow(
      request?.startsAt,
      request?.endsAt,
    );
    const totalRedemptionLimit = this.validateOptionalPositive(
      request?.totalRedemptionLimit,
      'total redemption limit',
      TOTAL_LIMIT_MAX,
    );
    const perCustomerRedemptionLimit = this.validateOptionalPositive(
      request?.perCustomerRedemptionLimit,
      'per-customer redemption limit',
      PER_CUSTOMER_LIMIT_MAX,
    );

    await this.assertCatalogIdsExist(productIds, categoryIds);
    if (locationIds.length > 0) {
      await this.assertLocationsExist(locationIds);
    }
    if (code !== null) {
      await this.assertCodeAvailable(code, null);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const promotion = await tx.promotion.create({
        data: {
          name,
          description,
          kind,
          code,
          discountType,
          discountValue,
          maxDiscountMinorUnits,
          applicability,
          minimumSubtotalMinorUnits,
          appliesToAllLocations,
          startsAt,
          endsAt,
          totalRedemptionLimit,
          perCustomerRedemptionLimit,
          eligibleProducts:
            productIds.length > 0
              ? { create: productIds.map((productId) => ({ productId })) }
              : undefined,
          eligibleCategories:
            categoryIds.length > 0
              ? { create: categoryIds.map((categoryId) => ({ categoryId })) }
              : undefined,
          eligibleLocations:
            locationIds.length > 0
              ? { create: locationIds.map((locationId) => ({ locationId })) }
              : undefined,
        },
        include: PROMOTION_INCLUDE,
      });

      await this.audit.recordPromotionCreated(tx, {
        actorInternalUserId,
        promotionId: promotion.id,
        snapshot: this.auditSnapshot(promotion),
      });

      return promotion;
    });

    return this.toAdminPromotion(created);
  }

  async updatePromotion(
    promotionId: string,
    request: UpdatePromotionRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminPromotion> {
    authorization.assertCorporate('promotions.configure');

    const current = await this.prisma.promotion.findUnique({
      where: { id: promotionId },
      include: PROMOTION_INCLUDE,
    });
    if (!current) {
      throw new NotFoundException('Promotion not found.');
    }

    // `kind` and `discountType` are fixed at creation.
    if (
      (request as { kind?: unknown })?.kind !== undefined &&
      (request as { kind?: unknown }).kind !== current.kind
    ) {
      throw new BadRequestException("A promotion's kind cannot be changed.");
    }
    if (
      (request as { discountType?: unknown })?.discountType !== undefined &&
      (request as { discountType?: unknown }).discountType !==
        current.discountType
    ) {
      throw new BadRequestException(
        "A promotion's discount type cannot be changed.",
      );
    }

    const data: Prisma.PromotionUpdateInput = {};

    if (request?.name !== undefined) {
      data.name = this.validateName(request.name);
    }
    if (request?.description !== undefined) {
      data.description = this.validateDescription(request.description);
    }

    let nextCode: string | null | undefined;
    if (request?.code !== undefined) {
      nextCode = this.validateCode(request.code, current.kind);
      if (nextCode !== current.code) {
        if (nextCode !== null) {
          await this.assertCodeAvailable(nextCode, promotionId);
        }
        data.code = nextCode;
      }
    }

    let change: 'updated' | 'activated' | 'deactivated' = 'updated';
    if (request?.isActive !== undefined) {
      if (typeof request.isActive !== 'boolean') {
        throw new BadRequestException('isActive must be a boolean.');
      }
      if (request.isActive !== current.isActive) {
        data.isActive = request.isActive;
        change = request.isActive ? 'activated' : 'deactivated';
      }
    }

    // Discount value / cap — re-validate against the fixed discount type.
    if (
      request?.discountValue !== undefined ||
      request?.maxDiscountMinorUnits !== undefined
    ) {
      const { discountValue, maxDiscountMinorUnits } = this.validateDiscountValue(
        current.discountType,
        request?.discountValue !== undefined
          ? request.discountValue
          : current.discountValue,
        request?.maxDiscountMinorUnits !== undefined
          ? request.maxDiscountMinorUnits
          : current.maxDiscountMinorUnits,
      );
      data.discountValue = discountValue;
      data.maxDiscountMinorUnits = maxDiscountMinorUnits;
    }

    if (request?.minimumSubtotalMinorUnits !== undefined) {
      data.minimumSubtotalMinorUnits = this.validateOptionalMinorUnits(
        request.minimumSubtotalMinorUnits,
        'minimum purchase',
        0,
        MINIMUM_SUBTOTAL_MAX,
      );
    }
    if (request?.totalRedemptionLimit !== undefined) {
      data.totalRedemptionLimit = this.validateOptionalPositive(
        request.totalRedemptionLimit,
        'total redemption limit',
        TOTAL_LIMIT_MAX,
      );
    }
    if (request?.perCustomerRedemptionLimit !== undefined) {
      data.perCustomerRedemptionLimit = this.validateOptionalPositive(
        request.perCustomerRedemptionLimit,
        'per-customer redemption limit',
        PER_CUSTOMER_LIMIT_MAX,
      );
    }

    // Applicability + eligibility resolve to a consistent end state.
    const nextApplicability =
      request?.applicability !== undefined
        ? this.validateApplicability(request.applicability, current.discountType)
        : (current.applicability as PromotionApplicability);
    let nextProductIds: string[] | null = null;
    let nextCategoryIds: string[] | null = null;
    if (
      request?.applicability !== undefined ||
      request?.eligibleProductIds !== undefined ||
      request?.eligibleCategoryIds !== undefined
    ) {
      nextProductIds =
        request?.eligibleProductIds !== undefined
          ? this.normalizeIdList(request.eligibleProductIds)
          : current.eligibleProducts.map((e) => e.productId);
      nextCategoryIds =
        request?.eligibleCategoryIds !== undefined
          ? this.normalizeIdList(request.eligibleCategoryIds)
          : current.eligibleCategories.map((e) => e.categoryId);
      this.assertApplicabilityTargets(
        nextApplicability,
        current.discountType,
        nextProductIds,
        nextCategoryIds,
      );
      await this.assertCatalogIdsExist(nextProductIds, nextCategoryIds);
      data.applicability = nextApplicability;
    }

    let nextLocationIds: string[] | null = null;
    if (
      request?.appliesToAllLocations !== undefined ||
      request?.eligibleLocationIds !== undefined
    ) {
      const intendedAll =
        request?.appliesToAllLocations !== undefined
          ? request.appliesToAllLocations
          : current.appliesToAllLocations;
      const intendedIds =
        request?.eligibleLocationIds !== undefined
          ? this.normalizeIdList(request.eligibleLocationIds)
          : current.eligibleLocations.map((e) => e.locationId);
      const resolved = this.validateLocations(intendedAll, intendedIds);
      nextLocationIds = resolved.locationIds;
      if (nextLocationIds.length > 0) {
        await this.assertLocationsExist(nextLocationIds);
      }
      data.appliesToAllLocations = resolved.appliesToAllLocations;
    }

    if (request?.startsAt !== undefined || request?.endsAt !== undefined) {
      const window = this.validateWindow(
        request?.startsAt !== undefined
          ? request.startsAt
          : current.startsAt?.toISOString() ?? null,
        request?.endsAt !== undefined
          ? request.endsAt
          : current.endsAt?.toISOString() ?? null,
      );
      data.startsAt = window.startsAt;
      data.endsAt = window.endsAt;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.promotion.update({ where: { id: promotionId }, data });

      if (nextProductIds !== null) {
        await tx.promotionProduct.deleteMany({ where: { promotionId } });
        if (nextProductIds.length > 0) {
          await tx.promotionProduct.createMany({
            data: nextProductIds.map((productId) => ({ promotionId, productId })),
          });
        }
      }
      if (nextCategoryIds !== null) {
        await tx.promotionCategory.deleteMany({ where: { promotionId } });
        if (nextCategoryIds.length > 0) {
          await tx.promotionCategory.createMany({
            data: nextCategoryIds.map((categoryId) => ({
              promotionId,
              categoryId,
            })),
          });
        }
      }
      if (nextLocationIds !== null) {
        await tx.promotionLocation.deleteMany({ where: { promotionId } });
        if (nextLocationIds.length > 0) {
          await tx.promotionLocation.createMany({
            data: nextLocationIds.map((locationId) => ({
              promotionId,
              locationId,
            })),
          });
        }
      }

      const fresh = await tx.promotion.findUniqueOrThrow({
        where: { id: promotionId },
        include: PROMOTION_INCLUDE,
      });

      await this.audit.recordPromotionUpdated(tx, {
        actorInternalUserId,
        promotionId,
        change,
        before: this.auditSnapshot(current),
        after: this.auditSnapshot(fresh),
      });

      return fresh;
    });

    return this.toAdminPromotion(updated);
  }

  // --- helpers -------------------------------------------------

  private toAdminPromotion(promotion: PromotionWithTargets): AdminPromotion {
    return {
      id: promotion.id,
      name: promotion.name,
      description: promotion.description,
      kind: promotion.kind,
      code: promotion.code,
      discountType: promotion.discountType,
      discountValue: promotion.discountValue,
      maxDiscountMinorUnits: promotion.maxDiscountMinorUnits,
      applicability: promotion.applicability,
      minimumSubtotalMinorUnits: promotion.minimumSubtotalMinorUnits,
      isActive: promotion.isActive,
      startsAt: promotion.startsAt?.toISOString() ?? null,
      endsAt: promotion.endsAt?.toISOString() ?? null,
      appliesToAllLocations: promotion.appliesToAllLocations,
      totalRedemptionLimit: promotion.totalRedemptionLimit,
      perCustomerRedemptionLimit: promotion.perCustomerRedemptionLimit,
      redemptionCount: promotion.redemptionCount,
      eligibleProducts: promotion.eligibleProducts.map((e) => ({
        id: e.product.id,
        name: e.product.name,
      })),
      eligibleCategories: promotion.eligibleCategories.map((e) => ({
        id: e.category.id,
        name: e.category.name,
      })),
      eligibleLocations: promotion.appliesToAllLocations
        ? []
        : promotion.eligibleLocations.map((e) => ({
            id: e.location.id,
            name: e.location.name,
          })),
      createdAt: promotion.createdAt.toISOString(),
      updatedAt: promotion.updatedAt.toISOString(),
    };
  }

  private auditSnapshot(
    promotion: PromotionWithTargets,
  ): Prisma.InputJsonObject {
    return {
      name: promotion.name,
      description: promotion.description,
      kind: promotion.kind,
      code: promotion.code,
      discountType: promotion.discountType,
      discountValue: promotion.discountValue,
      maxDiscountMinorUnits: promotion.maxDiscountMinorUnits,
      applicability: promotion.applicability,
      minimumSubtotalMinorUnits: promotion.minimumSubtotalMinorUnits,
      isActive: promotion.isActive,
      startsAt: promotion.startsAt?.toISOString() ?? null,
      endsAt: promotion.endsAt?.toISOString() ?? null,
      appliesToAllLocations: promotion.appliesToAllLocations,
      totalRedemptionLimit: promotion.totalRedemptionLimit,
      perCustomerRedemptionLimit: promotion.perCustomerRedemptionLimit,
      eligibleProductIds: promotion.eligibleProducts.map((e) => e.productId),
      eligibleCategoryIds: promotion.eligibleCategories.map((e) => e.categoryId),
      eligibleLocationIds: promotion.eligibleLocations.map((e) => e.locationId),
    };
  }

  private validateName(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new BadRequestException('A promotion name is required.');
    }
    const name = raw.trim();
    if (name.length > NAME_MAX_LENGTH) {
      throw new BadRequestException(
        `The promotion name must be ${NAME_MAX_LENGTH} characters or fewer.`,
      );
    }
    return name;
  }

  private validateDescription(raw: unknown): string | null {
    if (raw === undefined || raw === null) {
      return null;
    }
    if (typeof raw !== 'string') {
      throw new BadRequestException('The description must be a string or null.');
    }
    const description = raw.trim();
    if (description.length === 0) {
      return null;
    }
    if (description.length > DESCRIPTION_MAX_LENGTH) {
      throw new BadRequestException(
        `The description must be ${DESCRIPTION_MAX_LENGTH} characters or fewer.`,
      );
    }
    return description;
  }

  private validateKind(raw: unknown): PromotionKind {
    if (raw !== 'AUTOMATIC' && raw !== 'COUPON') {
      throw new BadRequestException('The kind must be AUTOMATIC or COUPON.');
    }
    return raw;
  }

  private validateDiscountType(raw: unknown): PromotionDiscountType {
    if (
      raw !== 'PERCENTAGE_OFF' &&
      raw !== 'FIXED_AMOUNT' &&
      raw !== 'FREE_ITEM'
    ) {
      throw new BadRequestException(
        'The discount type must be PERCENTAGE_OFF, FIXED_AMOUNT or FREE_ITEM.',
      );
    }
    return raw;
  }

  private validateCode(raw: unknown, kind: PromotionKind): string | null {
    if (kind === 'AUTOMATIC') {
      if (raw !== undefined && raw !== null && raw !== '') {
        throw new BadRequestException(
          'An automatic promotion does not take a coupon code.',
        );
      }
      return null;
    }
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new BadRequestException('A coupon needs a code.');
    }
    const normalized = normalizeCouponCode(raw);
    if (normalized === null) {
      throw new BadRequestException(
        'The coupon code must be 3–40 characters: letters, digits, hyphens or underscores.',
      );
    }
    return normalized;
  }

  private validateApplicability(
    raw: unknown,
    discountType: PromotionDiscountType,
  ): PromotionApplicability {
    let applicability: PromotionApplicability;
    if (raw === undefined || raw === null) {
      applicability = 'ENTIRE_ORDER';
    } else if (
      raw === 'ENTIRE_ORDER' ||
      raw === 'SELECTED_PRODUCTS' ||
      raw === 'SELECTED_CATEGORIES'
    ) {
      applicability = raw;
    } else {
      throw new BadRequestException(
        'Applicability must be ENTIRE_ORDER, SELECTED_PRODUCTS or SELECTED_CATEGORIES.',
      );
    }
    if (discountType === 'FREE_ITEM' && applicability === 'ENTIRE_ORDER') {
      throw new BadRequestException(
        'A free-item promotion must target selected products or categories.',
      );
    }
    return applicability;
  }

  private assertApplicabilityTargets(
    applicability: PromotionApplicability,
    discountType: PromotionDiscountType,
    productIds: string[],
    categoryIds: string[],
  ): void {
    if (applicability === 'SELECTED_PRODUCTS' && productIds.length === 0) {
      throw new BadRequestException(
        'Select at least one eligible product for this promotion.',
      );
    }
    if (applicability === 'SELECTED_CATEGORIES' && categoryIds.length === 0) {
      throw new BadRequestException(
        'Select at least one eligible category for this promotion.',
      );
    }
    if (
      discountType === 'FREE_ITEM' &&
      productIds.length === 0 &&
      categoryIds.length === 0
    ) {
      throw new BadRequestException(
        'A free-item promotion needs at least one eligible product or category.',
      );
    }
    if (applicability === 'ENTIRE_ORDER') {
      if (productIds.length > 0 || categoryIds.length > 0) {
        throw new BadRequestException(
          'A whole-order promotion does not take eligible products or categories.',
        );
      }
    }
    if (applicability === 'SELECTED_PRODUCTS' && categoryIds.length > 0) {
      throw new BadRequestException(
        'A product-targeted promotion does not take eligible categories.',
      );
    }
    if (applicability === 'SELECTED_CATEGORIES' && productIds.length > 0) {
      throw new BadRequestException(
        'A category-targeted promotion does not take eligible products.',
      );
    }
  }

  private validateDiscountValue(
    discountType: PromotionDiscountType,
    rawValue: unknown,
    rawMax: unknown,
  ): { discountValue: number; maxDiscountMinorUnits: number | null } {
    if (discountType === 'FREE_ITEM') {
      if (rawMax !== undefined && rawMax !== null) {
        throw new BadRequestException(
          'A free-item promotion does not take a maximum discount.',
        );
      }
      return { discountValue: 0, maxDiscountMinorUnits: null };
    }
    if (typeof rawValue !== 'number' || !Number.isInteger(rawValue)) {
      throw new BadRequestException('The discount value must be a whole number.');
    }
    if (discountType === 'PERCENTAGE_OFF') {
      if (rawValue < 1 || rawValue > 100) {
        throw new BadRequestException(
          'A percentage discount must be a whole number between 1 and 100.',
        );
      }
      const maxDiscountMinorUnits = this.validateOptionalPositive(
        rawMax,
        'maximum discount',
        MAX_DISCOUNT_MAX,
      );
      return { discountValue: rawValue, maxDiscountMinorUnits };
    }
    // FIXED_AMOUNT
    if (rawValue < 1 || rawValue > FIXED_AMOUNT_MAX) {
      throw new BadRequestException(
        'A fixed discount must be a positive whole number of cents.',
      );
    }
    if (rawMax !== undefined && rawMax !== null) {
      throw new BadRequestException(
        'A fixed-amount promotion does not take a maximum discount.',
      );
    }
    return { discountValue: rawValue, maxDiscountMinorUnits: null };
  }

  private validateOptionalPositive(
    raw: unknown,
    label: string,
    max: number,
  ): number | null {
    if (raw === undefined || raw === null) {
      return null;
    }
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw <= 0 ||
      raw > max
    ) {
      throw new BadRequestException(
        `The ${label} must be a positive whole number (max ${max}).`,
      );
    }
    return raw;
  }

  private validateOptionalMinorUnits(
    raw: unknown,
    label: string,
    min: number,
    max: number,
  ): number | null {
    if (raw === undefined || raw === null) {
      return null;
    }
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < min ||
      raw > max
    ) {
      throw new BadRequestException(
        `The ${label} must be a whole number between ${min} and ${max} cents.`,
      );
    }
    return raw;
  }

  private validateLocations(
    rawAll: unknown,
    rawIds: unknown,
  ): { appliesToAllLocations: boolean; locationIds: string[] } {
    if (rawAll !== undefined && typeof rawAll !== 'boolean') {
      throw new BadRequestException('appliesToAllLocations must be a boolean.');
    }
    const appliesToAllLocations = rawAll === true;
    const locationIds = appliesToAllLocations
      ? []
      : this.normalizeIdList(rawIds);
    if (!appliesToAllLocations && locationIds.length === 0) {
      throw new BadRequestException(
        'Choose all locations, or select at least one location.',
      );
    }
    return { appliesToAllLocations, locationIds };
  }

  private validateWindow(
    rawStart: unknown,
    rawEnd: unknown,
  ): { startsAt: Date | null; endsAt: Date | null } {
    const startsAt = this.parseDate(rawStart, 'startsAt');
    const endsAt = this.parseDate(rawEnd, 'endsAt');
    if (startsAt !== null && endsAt !== null && endsAt <= startsAt) {
      throw new BadRequestException('The end date must be after the start date.');
    }
    return { startsAt, endsAt };
  }

  private parseDate(raw: unknown, field: string): Date | null {
    if (raw === undefined || raw === null || raw === '') {
      return null;
    }
    if (typeof raw !== 'string') {
      throw new BadRequestException(
        `${field} must be an ISO date string or null.`,
      );
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} is not a valid date.`);
    }
    return date;
  }

  private normalizeIdList(raw: unknown): string[] {
    if (raw === undefined || raw === null) {
      return [];
    }
    if (
      !Array.isArray(raw) ||
      raw.some((id) => typeof id !== 'string' || id.trim().length === 0)
    ) {
      throw new BadRequestException('Ids must be non-empty strings.');
    }
    return [...new Set((raw as string[]).map((id) => id.trim()))];
  }

  private async assertCatalogIdsExist(
    productIds: string[],
    categoryIds: string[],
  ): Promise<void> {
    if (productIds.length > 0) {
      const found = await this.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true },
      });
      if (found.length !== productIds.length) {
        throw new BadRequestException(
          'One or more eligible products do not exist.',
        );
      }
    }
    if (categoryIds.length > 0) {
      const found = await this.prisma.category.findMany({
        where: { id: { in: categoryIds } },
        select: { id: true },
      });
      if (found.length !== categoryIds.length) {
        throw new BadRequestException(
          'One or more eligible categories do not exist.',
        );
      }
    }
  }

  private async assertLocationsExist(locationIds: string[]): Promise<void> {
    const found = await this.prisma.location.findMany({
      where: { id: { in: locationIds } },
      select: { id: true },
    });
    if (found.length !== locationIds.length) {
      throw new BadRequestException(
        'One or more selected locations do not exist.',
      );
    }
  }

  private async assertCodeAvailable(
    normalizedCode: string,
    excludePromotionId: string | null,
  ): Promise<void> {
    const existing = await this.prisma.promotion.findUnique({
      where: { code: normalizedCode },
      select: { id: true },
    });
    if (existing && existing.id !== excludePromotionId) {
      throw new ConflictException('That coupon code is already in use.');
    }
  }
}
