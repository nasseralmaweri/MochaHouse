import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminLoyaltyBonusPromotion,
  AdminLoyaltyBonusPromotionOptions,
  AdminLoyaltyBonusPromotionsResponse,
  CreateLoyaltyBonusPromotionRequest,
  UpdateLoyaltyBonusPromotionRequest,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';

// HQ management of Bonus Mocha Beans Promotions (Milestone 7D).
// `loyalty.configure` is CORPORATE-only in the permission catalog —
// PermissionGuard rejects a LOCATION grant and every method here also calls
// `assertCorporate`. Deliberately simple: two bonus types, product
// targeting only, all-or-selected locations, an optional flat date window.
// Promotions are never hard-deleted (isActive is the off switch) so a
// historical OrderLoyaltyBonusItem can always still point at the promotion
// it used. `type` is fixed at creation.

const NAME_MAX_LENGTH = 120;
const EXTRA_BEANS_MAX = 100_000;
const MULTIPLIER_MIN = 2;
const MULTIPLIER_MAX = 10;

type PromotionWithTargets = Prisma.LoyaltyBonusPromotionGetPayload<{
  include: {
    eligibleProducts: { include: { product: { select: { id: true; name: true } } } };
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
  eligibleLocations: {
    include: { location: { select: { id: true, name: true } } },
    orderBy: { locationId: 'asc' },
  },
} satisfies Prisma.LoyaltyBonusPromotionInclude;

// Deterministic list order: newest last is unhelpful for HQ; show by
// creation order, stable id tiebreak — the same order the earning path
// uses for its "first promotion wins a tie" rule.
const PROMOTION_ORDER_BY: Prisma.LoyaltyBonusPromotionOrderByWithRelationInput[] =
  [{ createdAt: 'asc' }, { id: 'asc' }];

@Injectable()
export class LoyaltyBonusPromotionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  async listPromotions(
    authorization: AuthorizationContext,
  ): Promise<AdminLoyaltyBonusPromotionsResponse> {
    authorization.assertCorporate('loyalty.configure');
    const promotions = await this.prisma.loyaltyBonusPromotion.findMany({
      include: PROMOTION_INCLUDE,
      orderBy: PROMOTION_ORDER_BY,
    });
    return { promotions: promotions.map((p) => this.toAdminPromotion(p)) };
  }

  // Product + location picker data. Identity + name only — managing
  // promotions never requires `catalog.view` or `locations.view`.
  async getOptions(
    authorization: AuthorizationContext,
  ): Promise<AdminLoyaltyBonusPromotionOptions> {
    authorization.assertCorporate('loyalty.configure');
    const [products, locations] = await Promise.all([
      this.prisma.product.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.location.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return { products, locations };
  }

  async createPromotion(
    request: CreateLoyaltyBonusPromotionRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminLoyaltyBonusPromotion> {
    authorization.assertCorporate('loyalty.configure');

    const name = this.validateName(request?.name);
    const type = this.validateType(request?.type);
    const bonusValue = this.validateBonusValue(request?.bonusValue, type);
    const productIds = this.normalizeIdList(request?.eligibleProductIds);
    if (productIds.length === 0) {
      throw new BadRequestException(
        'A bonus promotion needs at least one eligible product.',
      );
    }
    const { appliesToAllLocations, locationIds } = this.validateLocations(
      request?.appliesToAllLocations,
      request?.eligibleLocationIds,
    );
    const { startsAt, endsAt } = this.validateWindow(
      request?.startsAt,
      request?.endsAt,
    );

    await this.assertProductsExist(productIds);
    if (locationIds.length > 0) {
      await this.assertLocationsExist(locationIds);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const promotion = await tx.loyaltyBonusPromotion.create({
        data: {
          name,
          type,
          bonusValue,
          appliesToAllLocations,
          startsAt,
          endsAt,
          eligibleProducts: {
            create: productIds.map((productId) => ({ productId })),
          },
          eligibleLocations:
            locationIds.length > 0
              ? { create: locationIds.map((locationId) => ({ locationId })) }
              : undefined,
        },
        include: PROMOTION_INCLUDE,
      });

      await this.audit.recordLoyaltyBonusPromotionCreated(tx, {
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
    request: UpdateLoyaltyBonusPromotionRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminLoyaltyBonusPromotion> {
    authorization.assertCorporate('loyalty.configure');

    const current = await this.prisma.loyaltyBonusPromotion.findUnique({
      where: { id: promotionId },
      include: PROMOTION_INCLUDE,
    });
    if (!current) {
      throw new NotFoundException('Bonus promotion not found.');
    }

    // `type` is never editable — the request cannot carry it; this is the
    // defence if it somehow does.
    if (
      (request as { type?: unknown })?.type !== undefined &&
      (request as { type?: unknown }).type !== current.type
    ) {
      throw new BadRequestException("A promotion's type cannot be changed.");
    }

    const data: Prisma.LoyaltyBonusPromotionUpdateInput = {};

    if (request?.name !== undefined) {
      data.name = this.validateName(request.name);
    }
    if (request?.bonusValue !== undefined) {
      data.bonusValue = this.validateBonusValue(request.bonusValue, current.type);
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

    // Location targeting — resolve the intended end state so all-vs-selected
    // stays consistent even when only one field is provided.
    let nextLocationIds: string[] | null = null;
    let nextAppliesToAll: boolean | null = null;
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
      nextAppliesToAll = resolved.appliesToAllLocations;
      nextLocationIds = resolved.locationIds;
      if (nextLocationIds.length > 0) {
        await this.assertLocationsExist(nextLocationIds);
      }
      data.appliesToAllLocations = nextAppliesToAll;
    }

    let nextProductIds: string[] | null = null;
    if (request?.eligibleProductIds !== undefined) {
      nextProductIds = this.normalizeIdList(request.eligibleProductIds);
      if (nextProductIds.length === 0) {
        throw new BadRequestException(
          'A bonus promotion needs at least one eligible product.',
        );
      }
      await this.assertProductsExist(nextProductIds);
    }

    // Date window — validate against the intended end state.
    if (request?.startsAt !== undefined || request?.endsAt !== undefined) {
      const intendedStart =
        request?.startsAt !== undefined
          ? request.startsAt
          : current.startsAt?.toISOString() ?? null;
      const intendedEnd =
        request?.endsAt !== undefined
          ? request.endsAt
          : current.endsAt?.toISOString() ?? null;
      const window = this.validateWindow(intendedStart, intendedEnd);
      data.startsAt = window.startsAt;
      data.endsAt = window.endsAt;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.loyaltyBonusPromotion.update({
        where: { id: promotionId },
        data,
      });

      if (nextProductIds !== null) {
        await tx.loyaltyBonusPromotionProduct.deleteMany({
          where: { promotionId },
        });
        await tx.loyaltyBonusPromotionProduct.createMany({
          data: nextProductIds.map((productId) => ({ promotionId, productId })),
        });
      }

      if (nextLocationIds !== null) {
        await tx.loyaltyBonusPromotionLocation.deleteMany({
          where: { promotionId },
        });
        if (nextLocationIds.length > 0) {
          await tx.loyaltyBonusPromotionLocation.createMany({
            data: nextLocationIds.map((locationId) => ({
              promotionId,
              locationId,
            })),
          });
        }
      }

      const fresh = await tx.loyaltyBonusPromotion.findUniqueOrThrow({
        where: { id: promotionId },
        include: PROMOTION_INCLUDE,
      });

      await this.audit.recordLoyaltyBonusPromotionUpdated(tx, {
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

  private toAdminPromotion(
    promotion: PromotionWithTargets,
  ): AdminLoyaltyBonusPromotion {
    return {
      id: promotion.id,
      name: promotion.name,
      type: promotion.type,
      bonusValue: promotion.bonusValue,
      isActive: promotion.isActive,
      startsAt: promotion.startsAt?.toISOString() ?? null,
      endsAt: promotion.endsAt?.toISOString() ?? null,
      appliesToAllLocations: promotion.appliesToAllLocations,
      eligibleProducts: promotion.eligibleProducts.map((e) => ({
        id: e.product.id,
        name: e.product.name,
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
      type: promotion.type,
      bonusValue: promotion.bonusValue,
      isActive: promotion.isActive,
      startsAt: promotion.startsAt?.toISOString() ?? null,
      endsAt: promotion.endsAt?.toISOString() ?? null,
      appliesToAllLocations: promotion.appliesToAllLocations,
      eligibleProductIds: promotion.eligibleProducts.map((e) => e.productId),
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

  private validateType(raw: unknown): 'EXTRA_BEANS' | 'MULTIPLIER' {
    if (raw !== 'EXTRA_BEANS' && raw !== 'MULTIPLIER') {
      throw new BadRequestException(
        'The bonus type must be EXTRA_BEANS or MULTIPLIER.',
      );
    }
    return raw;
  }

  private validateBonusValue(
    raw: unknown,
    type: 'EXTRA_BEANS' | 'MULTIPLIER',
  ): number {
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      throw new BadRequestException('The bonus value must be a whole number.');
    }
    if (type === 'EXTRA_BEANS') {
      if (raw <= 0 || raw > EXTRA_BEANS_MAX) {
        throw new BadRequestException(
          `Extra Beans must be a whole number between 1 and ${EXTRA_BEANS_MAX}.`,
        );
      }
    } else {
      if (raw < MULTIPLIER_MIN || raw > MULTIPLIER_MAX) {
        throw new BadRequestException(
          `The multiplier must be a whole number between ${MULTIPLIER_MIN} and ${MULTIPLIER_MAX}.`,
        );
      }
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
      throw new BadRequestException(`${field} must be an ISO date string or null.`);
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
      throw new BadRequestException(
        'Product and location ids must be non-empty strings.',
      );
    }
    return [...new Set((raw as string[]).map((id) => id.trim()))];
  }

  private async assertProductsExist(productIds: string[]): Promise<void> {
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
}
