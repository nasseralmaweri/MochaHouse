import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminLoyaltyCatalogOptions,
  AdminLoyaltyReward,
  AdminLoyaltyRewardsResponse,
  CreateLoyaltyRewardRequest,
  CustomerLoyaltyReward,
  UpdateLoyaltyRewardRequest,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';

// The HQ Rewards Catalog (Milestone 7B). `loyalty.configure` is
// CORPORATE-only — PermissionGuard rejects a LOCATION grant and every
// method also calls `assertCorporate`. This slice manages the catalog
// only: rewards are never redeemed, no Beans move, and there are no
// redemption/snapshot tables. Rewards are never hard-deleted (isActive is
// the off switch) so a future redemption record can always still point at
// the reward it used.

const NAME_MAX_LENGTH = 120;
const DESCRIPTION_MAX_LENGTH = 500;
const BEAN_COST_MAX = 1_000_000;
const FIXED_AMOUNT_MAX_MINOR_UNITS = 1_000_000; // $10,000
const SORT_ORDER_MAX = 100_000;

type RewardWithEligibility = Prisma.LoyaltyRewardGetPayload<{
  include: {
    eligibleProducts: { include: { product: { select: { id: true; name: true } } } };
    eligibleCategories: {
      include: { category: { select: { id: true; name: true } } };
    };
  };
}>;

const REWARD_INCLUDE = {
  eligibleProducts: {
    include: { product: { select: { id: true, name: true } } },
    orderBy: { productId: 'asc' },
  },
  eligibleCategories: {
    include: { category: { select: { id: true, name: true } } },
    orderBy: { categoryId: 'asc' },
  },
} satisfies Prisma.LoyaltyRewardInclude;

// Deterministic catalog order: sortOrder, then stable id.
const REWARD_ORDER_BY: Prisma.LoyaltyRewardOrderByWithRelationInput[] = [
  { sortOrder: 'asc' },
  { id: 'asc' },
];

@Injectable()
export class LoyaltyRewardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  // --- Admin ------------------------------------------------------

  async listAdminRewards(
    authorization: AuthorizationContext,
  ): Promise<AdminLoyaltyRewardsResponse> {
    authorization.assertCorporate('loyalty.configure');
    const rewards = await this.prisma.loyaltyReward.findMany({
      include: REWARD_INCLUDE,
      orderBy: REWARD_ORDER_BY,
    });
    return { rewards: rewards.map((r) => this.toAdminReward(r)) };
  }

  // Product/category picker data for the FREE_ITEM reward form. Identity +
  // name only — managing rewards never requires `catalog.view`.
  async getCatalogOptions(
    authorization: AuthorizationContext,
  ): Promise<AdminLoyaltyCatalogOptions> {
    authorization.assertCorporate('loyalty.configure');
    const [products, categories] = await Promise.all([
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
    ]);
    return { products, categories };
  }

  async createReward(
    request: CreateLoyaltyRewardRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminLoyaltyReward> {
    authorization.assertCorporate('loyalty.configure');

    const name = this.validateName(request?.name);
    const description = this.validateDescription(request?.description);
    const beanCost = this.validateBeanCost(request?.beanCost);
    const sortOrder = this.validateSortOrder(request?.sortOrder);
    const type = this.validateType(request?.type);

    const productIds = this.normalizeIdList(request?.eligibleProductIds);
    const categoryIds = this.normalizeIdList(request?.eligibleCategoryIds);

    let fixedAmountMinorUnits: number | null = null;

    if (type === 'FIXED_AMOUNT') {
      fixedAmountMinorUnits = this.validateFixedAmount(
        request?.fixedAmountMinorUnits,
      );
      if (productIds.length > 0 || categoryIds.length > 0) {
        throw new BadRequestException(
          'A fixed dollar-off reward does not take eligible products or categories.',
        );
      }
    } else {
      if (
        request?.fixedAmountMinorUnits !== undefined &&
        request?.fixedAmountMinorUnits !== null
      ) {
        throw new BadRequestException(
          'A free-item reward does not take a fixed dollar amount.',
        );
      }
      if (productIds.length === 0 && categoryIds.length === 0) {
        throw new BadRequestException(
          'A free-item reward needs at least one eligible product or category.',
        );
      }
      await this.assertCatalogIdsExist(productIds, categoryIds);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const reward = await tx.loyaltyReward.create({
        data: {
          name,
          description,
          type,
          beanCost,
          fixedAmountMinorUnits,
          sortOrder,
          eligibleProducts:
            productIds.length > 0
              ? { create: productIds.map((productId) => ({ productId })) }
              : undefined,
          eligibleCategories:
            categoryIds.length > 0
              ? { create: categoryIds.map((categoryId) => ({ categoryId })) }
              : undefined,
        },
        include: REWARD_INCLUDE,
      });

      await this.audit.recordLoyaltyRewardCreated(tx, {
        actorInternalUserId,
        rewardId: reward.id,
        snapshot: this.auditSnapshot(reward),
      });

      return reward;
    });

    return this.toAdminReward(created);
  }

  async updateReward(
    rewardId: string,
    request: UpdateLoyaltyRewardRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminLoyaltyReward> {
    authorization.assertCorporate('loyalty.configure');

    const current = await this.prisma.loyaltyReward.findUnique({
      where: { id: rewardId },
      include: REWARD_INCLUDE,
    });
    if (!current) {
      throw new NotFoundException('Reward not found.');
    }

    // `type` is never editable — the request cannot carry it, and this is
    // the defence if it somehow does.
    if (
      (request as { type?: unknown })?.type !== undefined &&
      (request as { type?: unknown }).type !== current.type
    ) {
      throw new BadRequestException("A reward's type cannot be changed.");
    }

    const data: Prisma.LoyaltyRewardUpdateInput = {};

    if (request?.name !== undefined) {
      data.name = this.validateName(request.name);
    }
    if (request?.description !== undefined) {
      data.description = this.validateDescription(request.description);
    }
    if (request?.beanCost !== undefined) {
      data.beanCost = this.validateBeanCost(request.beanCost);
    }
    if (request?.sortOrder !== undefined) {
      data.sortOrder = this.validateSortOrder(request.sortOrder);
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

    // Type-specific fields.
    if (current.type === 'FIXED_AMOUNT') {
      if (request?.fixedAmountMinorUnits !== undefined) {
        data.fixedAmountMinorUnits = this.validateFixedAmount(
          request.fixedAmountMinorUnits,
        );
      }
      if (
        request?.eligibleProductIds !== undefined ||
        request?.eligibleCategoryIds !== undefined
      ) {
        throw new BadRequestException(
          'A fixed dollar-off reward does not take eligible products or categories.',
        );
      }
    }

    let nextProductIds: string[] | null = null;
    let nextCategoryIds: string[] | null = null;
    if (current.type === 'FREE_ITEM') {
      if (
        request?.fixedAmountMinorUnits !== undefined &&
        request?.fixedAmountMinorUnits !== null
      ) {
        throw new BadRequestException(
          'A free-item reward does not take a fixed dollar amount.',
        );
      }
      const productsProvided = request?.eligibleProductIds !== undefined;
      const categoriesProvided = request?.eligibleCategoryIds !== undefined;
      if (productsProvided || categoriesProvided) {
        nextProductIds = productsProvided
          ? this.normalizeIdList(request.eligibleProductIds)
          : current.eligibleProducts.map((e) => e.productId);
        nextCategoryIds = categoriesProvided
          ? this.normalizeIdList(request.eligibleCategoryIds)
          : current.eligibleCategories.map((e) => e.categoryId);
        if (nextProductIds.length === 0 && nextCategoryIds.length === 0) {
          throw new BadRequestException(
            'A free-item reward needs at least one eligible product or category.',
          );
        }
        await this.assertCatalogIdsExist(nextProductIds, nextCategoryIds);
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const reward = await tx.loyaltyReward.update({
        where: { id: rewardId },
        data,
        include: REWARD_INCLUDE,
      });

      if (nextProductIds !== null && nextCategoryIds !== null) {
        await tx.loyaltyRewardProduct.deleteMany({ where: { rewardId } });
        await tx.loyaltyRewardCategory.deleteMany({ where: { rewardId } });
        if (nextProductIds.length > 0) {
          await tx.loyaltyRewardProduct.createMany({
            data: nextProductIds.map((productId) => ({ rewardId, productId })),
          });
        }
        if (nextCategoryIds.length > 0) {
          await tx.loyaltyRewardCategory.createMany({
            data: nextCategoryIds.map((categoryId) => ({
              rewardId,
              categoryId,
            })),
          });
        }
      }

      const fresh = await tx.loyaltyReward.findUniqueOrThrow({
        where: { id: rewardId },
        include: REWARD_INCLUDE,
      });

      await this.audit.recordLoyaltyRewardUpdated(tx, {
        actorInternalUserId,
        rewardId,
        change,
        before: this.auditSnapshot(current),
        after: this.auditSnapshot(fresh),
      });

      return fresh;
    });

    return this.toAdminReward(updated);
  }

  // --- Customer -------------------------------------------------

  // Active rewards only, in catalog order, each annotated with whether the
  // customer can currently afford it. NO redemption, NO reservation, NO
  // Bean movement.
  async listActiveRewardsForCustomer(
    balance: number,
  ): Promise<CustomerLoyaltyReward[]> {
    const rewards = await this.prisma.loyaltyReward.findMany({
      where: { isActive: true },
      include: REWARD_INCLUDE,
      orderBy: REWARD_ORDER_BY,
    });
    return rewards.map((reward) => ({
      id: reward.id,
      name: reward.name,
      description: reward.description,
      type: reward.type,
      beanCost: reward.beanCost,
      fixedAmountMinorUnits: reward.fixedAmountMinorUnits,
      eligibleItemNames:
        reward.type === 'FREE_ITEM'
          ? [
              ...reward.eligibleProducts.map((e) => e.product.name),
              ...reward.eligibleCategories.map((e) => e.category.name),
            ]
          : [],
      canAfford: balance >= reward.beanCost,
    }));
  }

  // --- helpers -------------------------------------------------

  private toAdminReward(reward: RewardWithEligibility): AdminLoyaltyReward {
    return {
      id: reward.id,
      name: reward.name,
      description: reward.description,
      type: reward.type,
      beanCost: reward.beanCost,
      fixedAmountMinorUnits: reward.fixedAmountMinorUnits,
      isActive: reward.isActive,
      sortOrder: reward.sortOrder,
      eligibleProducts: reward.eligibleProducts.map((e) => ({
        id: e.product.id,
        name: e.product.name,
      })),
      eligibleCategories: reward.eligibleCategories.map((e) => ({
        id: e.category.id,
        name: e.category.name,
      })),
      createdAt: reward.createdAt.toISOString(),
      updatedAt: reward.updatedAt.toISOString(),
    };
  }

  private auditSnapshot(reward: RewardWithEligibility): Prisma.InputJsonObject {
    return {
      name: reward.name,
      description: reward.description,
      type: reward.type,
      beanCost: reward.beanCost,
      fixedAmountMinorUnits: reward.fixedAmountMinorUnits,
      isActive: reward.isActive,
      sortOrder: reward.sortOrder,
      eligibleProductIds: reward.eligibleProducts.map((e) => e.productId),
      eligibleCategoryIds: reward.eligibleCategories.map((e) => e.categoryId),
    };
  }

  private validateName(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new BadRequestException('A reward name is required.');
    }
    const name = raw.trim();
    if (name.length > NAME_MAX_LENGTH) {
      throw new BadRequestException(
        `The reward name must be ${NAME_MAX_LENGTH} characters or fewer.`,
      );
    }
    return name;
  }

  private validateDescription(raw: unknown): string | null {
    if (raw === undefined || raw === null) {
      return null;
    }
    if (typeof raw !== 'string') {
      throw new BadRequestException(
        'The description must be a string or null.',
      );
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

  private validateBeanCost(raw: unknown): number {
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw <= 0 ||
      raw > BEAN_COST_MAX
    ) {
      throw new BadRequestException(
        'The Bean cost must be a positive whole number.',
      );
    }
    return raw;
  }

  private validateFixedAmount(raw: unknown): number {
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw <= 0 ||
      raw > FIXED_AMOUNT_MAX_MINOR_UNITS
    ) {
      throw new BadRequestException(
        'The dollar-off amount must be a positive whole number of cents.',
      );
    }
    return raw;
  }

  private validateSortOrder(raw: unknown): number {
    if (raw === undefined || raw === null) {
      return 0;
    }
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < 0 ||
      raw > SORT_ORDER_MAX
    ) {
      throw new BadRequestException(
        'The display order must be a whole number between 0 and 100000.',
      );
    }
    return raw;
  }

  private validateType(raw: unknown): 'FIXED_AMOUNT' | 'FREE_ITEM' {
    if (raw !== 'FIXED_AMOUNT' && raw !== 'FREE_ITEM') {
      throw new BadRequestException(
        'The reward type must be FIXED_AMOUNT or FREE_ITEM.',
      );
    }
    return raw;
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
        'Eligible product and category ids must be non-empty strings.',
      );
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
}
