import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminCampaign,
  AdminCampaignOptions,
  AdminCampaignsResponse,
  CampaignStatus,
  CreateCampaignRequest,
  UpdateCampaignRequest,
} from '@mocha-house/contracts';
import {
  CAMPAIGN_DESCRIPTION_MAX_LENGTH,
  CAMPAIGN_FEATURED_PRODUCTS_MAX,
  CAMPAIGN_NAME_MAX_LENGTH,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';

const LIST_PAGE_SIZE = 25;

const CAMPAIGN_INCLUDE = {
  promotion: { select: { id: true, name: true, isActive: true } },
  loyaltyBonusPromotion: { select: { id: true, name: true, isActive: true } },
  featuredProducts: {
    include: {
      product: {
        select: {
          id: true,
          name: true,
          isActive: true,
          category: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { displayOrder: 'asc' },
  },
} satisfies Prisma.CampaignInclude;

type CampaignRow = Prisma.CampaignGetPayload<{ include: typeof CAMPAIGN_INCLUDE }>;

const CAMPAIGN_ORDER_BY: Prisma.CampaignOrderByWithRelationInput[] = [
  { createdAt: 'desc' },
  { id: 'desc' },
];

// HQ management of Marketing Campaigns (Milestone 8G). `marketing.view` /
// `marketing.manage` are CORPORATE-only in the permission catalog —
// PermissionGuard rejects a LOCATION grant and every method here also calls
// assertCorporate. A campaign ORGANIZES existing systems — it optionally
// references ONE Promotion and/or ONE LoyaltyBonusPromotion as independent
// optional benefits, and NEVER performs discount or Mocha Beans
// calculation itself. Status moves only through the dedicated
// DRAFT -> ACTIVE -> ENDED action (ENDED is terminal); activating or ending
// a campaign never mutates a linked Promotion / LoyaltyBonusPromotion.
@Injectable()
export class CampaignsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  async list(
    query: { status?: string; cursor?: string },
    authorization: AuthorizationContext,
  ): Promise<AdminCampaignsResponse> {
    authorization.assertCorporate('marketing.view');

    const where: Prisma.CampaignWhereInput = {};
    if (query.status !== undefined) {
      where.status = this.parseStatus(query.status);
    }
    if (typeof query.cursor === 'string' && query.cursor.length > 0) {
      // Campaign.id is a uuid7 — id-desc is monotonic with createdAt.
      where.id = { lt: query.cursor };
    }

    const rows = await this.prisma.campaign.findMany({
      where,
      include: CAMPAIGN_INCLUDE,
      orderBy: CAMPAIGN_ORDER_BY,
      take: LIST_PAGE_SIZE + 1,
    });
    const hasMore = rows.length > LIST_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, LIST_PAGE_SIZE) : rows;

    return {
      campaigns: page.map((row) => this.toAdminCampaign(row)),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  async getOptions(
    authorization: AuthorizationContext,
  ): Promise<AdminCampaignOptions> {
    authorization.assertCorporate('marketing.view');
    const [products, promotions, loyaltyBonusPromotions] = await Promise.all([
      this.prisma.product.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          isActive: true,
          category: { select: { id: true, name: true } },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.promotion.findMany({
        select: { id: true, name: true, isActive: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.loyaltyBonusPromotion.findMany({
        select: { id: true, name: true, isActive: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return { products, promotions, loyaltyBonusPromotions };
  }

  async getDetail(
    campaignId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminCampaign> {
    authorization.assertCorporate('marketing.view');
    return this.toAdminCampaign(await this.loadOrThrow(campaignId));
  }

  async create(
    request: CreateCampaignRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminCampaign> {
    authorization.assertCorporate('marketing.manage');

    const name = this.validateName(request?.name);
    const description = this.validateDescription(request?.description);
    const { startsAt, endsAt } = this.validateWindow(
      request?.startsAt,
      request?.endsAt,
    );
    const mediaAssetId = await this.validateMediaAssetId(request?.mediaAssetId);
    const promotionId = await this.validatePromotionId(request?.promotionId);
    const loyaltyBonusPromotionId = await this.validateLoyaltyBonusPromotionId(
      request?.loyaltyBonusPromotionId,
    );
    const featuredProductIds = this.normalizeFeaturedProductIds(
      request?.featuredProductIds,
    );
    if (featuredProductIds.length > 0) {
      await this.assertProductsExistAndActive(featuredProductIds);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const campaign = await tx.campaign.create({
        data: {
          name,
          description,
          startsAt,
          endsAt,
          mediaAssetId,
          promotionId,
          loyaltyBonusPromotionId,
          featuredProducts:
            featuredProductIds.length > 0
              ? {
                  create: featuredProductIds.map((productId, index) => ({
                    productId,
                    displayOrder: index,
                  })),
                }
              : undefined,
        },
        include: CAMPAIGN_INCLUDE,
      });

      await this.audit.recordCampaignCreated(tx, {
        actorInternalUserId,
        campaignId: campaign.id,
        snapshot: this.auditSnapshot(campaign),
      });

      return campaign;
    });

    return this.toAdminCampaign(created);
  }

  async update(
    campaignId: string,
    request: UpdateCampaignRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminCampaign> {
    authorization.assertCorporate('marketing.manage');

    const current = await this.loadOrThrow(campaignId);
    if (current.status === 'ENDED') {
      throw new ConflictException('An ended campaign cannot be edited.');
    }

    // Reject a status write smuggled through PATCH.
    if (
      request !== null &&
      typeof request === 'object' &&
      'status' in request
    ) {
      throw new BadRequestException(
        "A campaign's status is changed only through the dedicated status action.",
      );
    }

    const data: Prisma.CampaignUpdateInput = {};

    if (request?.name !== undefined) {
      data.name = this.validateName(request.name);
    }
    if (request?.description !== undefined) {
      data.description = this.validateDescription(request.description);
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
    if (request?.mediaAssetId !== undefined) {
      data.mediaAssetId = await this.validateMediaAssetId(request.mediaAssetId);
    }
    if (request?.promotionId !== undefined) {
      const promotionId = await this.validatePromotionId(request.promotionId);
      data.promotion = promotionId
        ? { connect: { id: promotionId } }
        : { disconnect: true };
    }
    if (request?.loyaltyBonusPromotionId !== undefined) {
      const loyaltyBonusPromotionId = await this.validateLoyaltyBonusPromotionId(
        request.loyaltyBonusPromotionId,
      );
      data.loyaltyBonusPromotion = loyaltyBonusPromotionId
        ? { connect: { id: loyaltyBonusPromotionId } }
        : { disconnect: true };
    }

    let nextFeaturedProductIds: string[] | null = null;
    if (request?.featuredProductIds !== undefined) {
      nextFeaturedProductIds = this.normalizeFeaturedProductIds(
        request.featuredProductIds,
      );
      if (nextFeaturedProductIds.length > 0) {
        await this.assertProductsExistAndActive(nextFeaturedProductIds);
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.campaign.update({ where: { id: campaignId }, data });

      if (nextFeaturedProductIds !== null) {
        await tx.campaignProduct.deleteMany({ where: { campaignId } });
        if (nextFeaturedProductIds.length > 0) {
          await tx.campaignProduct.createMany({
            data: nextFeaturedProductIds.map((productId, index) => ({
              campaignId,
              productId,
              displayOrder: index,
            })),
          });
        }
      }

      const fresh = await tx.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        include: CAMPAIGN_INCLUDE,
      });

      await this.audit.recordCampaignUpdated(tx, {
        actorInternalUserId,
        campaignId,
        before: this.auditSnapshot(current),
        after: this.auditSnapshot(fresh),
      });

      return fresh;
    });

    return this.toAdminCampaign(updated);
  }

  async activate(
    campaignId: string,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminCampaign> {
    authorization.assertCorporate('marketing.manage');
    const current = await this.loadOrThrow(campaignId);
    if (current.status !== 'DRAFT') {
      throw new ConflictException('Only a draft campaign can be activated.');
    }
    await this.assertReferencesUsableForActivation(current);
    return this.transition(campaignId, current.status, 'ACTIVE', actorInternalUserId);
  }

  async end(
    campaignId: string,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminCampaign> {
    authorization.assertCorporate('marketing.manage');
    const current = await this.loadOrThrow(campaignId);
    if (current.status !== 'ACTIVE') {
      throw new ConflictException('Only an active campaign can be ended.');
    }
    return this.transition(campaignId, current.status, 'ENDED', actorInternalUserId);
  }

  updateStatus(
    campaignId: string,
    status: unknown,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminCampaign> {
    if (status === 'ACTIVE') {
      return this.activate(campaignId, actorInternalUserId, authorization);
    }
    if (status === 'ENDED') {
      return this.end(campaignId, actorInternalUserId, authorization);
    }
    throw new BadRequestException(
      "status must be 'ACTIVE' (from DRAFT) or 'ENDED' (from ACTIVE).",
    );
  }

  // --- transitions ---------------------------------------------

  private async transition(
    campaignId: string,
    before: CampaignStatus,
    after: CampaignStatus,
    actorInternalUserId: string,
  ): Promise<AdminCampaign> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const campaign = await tx.campaign.update({
        where: { id: campaignId },
        data: { status: after },
        include: CAMPAIGN_INCLUDE,
      });
      await this.audit.recordCampaignStatusChanged(tx, {
        actorInternalUserId,
        campaignId,
        before,
        after,
      });
      return campaign;
    });
    return this.toAdminCampaign(updated);
  }

  // Activation-time revalidation. Never mutates the Promotion /
  // LoyaltyBonusPromotion / MediaAsset / Product it checks — a Campaign can
  // only be organized around them, never change them.
  private async assertReferencesUsableForActivation(
    campaign: CampaignRow,
  ): Promise<void> {
    if (campaign.mediaAssetId) {
      const media = await this.prisma.mediaAsset.findUnique({
        where: { id: campaign.mediaAssetId },
        select: { isActive: true },
      });
      if (!media || !media.isActive) {
        throw new ConflictException(
          'The campaign image is no longer active. Choose a different image before activating.',
        );
      }
    }
    if (campaign.featuredProducts.some((fp) => !fp.product.isActive)) {
      throw new ConflictException(
        'One or more featured products are no longer active. Update the featured products before activating.',
      );
    }
    if (campaign.promotion && !campaign.promotion.isActive) {
      throw new ConflictException(
        'The linked Promotion / Coupon is not currently active. Activate it, or unlink it, before activating this campaign.',
      );
    }
    if (
      campaign.loyaltyBonusPromotion &&
      !campaign.loyaltyBonusPromotion.isActive
    ) {
      throw new ConflictException(
        'The linked Bonus Mocha Bean Promotion is not currently active. Activate it, or unlink it, before activating this campaign.',
      );
    }
  }

  // --- helpers -------------------------------------------------

  private toAdminCampaign(campaign: CampaignRow): AdminCampaign {
    return {
      id: campaign.id,
      name: campaign.name,
      description: campaign.description,
      status: campaign.status,
      startsAt: campaign.startsAt?.toISOString() ?? null,
      endsAt: campaign.endsAt?.toISOString() ?? null,
      mediaAssetId: campaign.mediaAssetId,
      promotion: campaign.promotion
        ? {
            id: campaign.promotion.id,
            name: campaign.promotion.name,
            isActive: campaign.promotion.isActive,
          }
        : null,
      loyaltyBonusPromotion: campaign.loyaltyBonusPromotion
        ? {
            id: campaign.loyaltyBonusPromotion.id,
            name: campaign.loyaltyBonusPromotion.name,
            isActive: campaign.loyaltyBonusPromotion.isActive,
          }
        : null,
      featuredProducts: campaign.featuredProducts.map((fp) => ({
        id: fp.product.id,
        name: fp.product.name,
        category: fp.product.category,
        isActive: fp.product.isActive,
        displayOrder: fp.displayOrder,
      })),
      createdAt: campaign.createdAt.toISOString(),
      updatedAt: campaign.updatedAt.toISOString(),
    };
  }

  private auditSnapshot(campaign: CampaignRow): Prisma.InputJsonObject {
    return {
      name: campaign.name,
      description: campaign.description,
      status: campaign.status,
      startsAt: campaign.startsAt?.toISOString() ?? null,
      endsAt: campaign.endsAt?.toISOString() ?? null,
      mediaAssetId: campaign.mediaAssetId,
      promotionId: campaign.promotion?.id ?? null,
      loyaltyBonusPromotionId: campaign.loyaltyBonusPromotion?.id ?? null,
      featuredProductIds: campaign.featuredProducts.map((fp) => fp.product.id),
    };
  }

  private async loadOrThrow(campaignId: string): Promise<CampaignRow> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: CAMPAIGN_INCLUDE,
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found.');
    }
    return campaign;
  }

  private parseStatus(raw: string): CampaignStatus {
    if (raw === 'DRAFT' || raw === 'ACTIVE' || raw === 'ENDED') {
      return raw;
    }
    throw new BadRequestException('status must be DRAFT, ACTIVE or ENDED.');
  }

  private validateName(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new BadRequestException('A campaign name is required.');
    }
    const name = raw.trim();
    if (name.length > CAMPAIGN_NAME_MAX_LENGTH) {
      throw new BadRequestException(
        `The campaign name must be ${CAMPAIGN_NAME_MAX_LENGTH} characters or fewer.`,
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
    if (description.length > CAMPAIGN_DESCRIPTION_MAX_LENGTH) {
      throw new BadRequestException(
        `The description must be ${CAMPAIGN_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
      );
    }
    return description;
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

  private async validateMediaAssetId(raw: unknown): Promise<string | null> {
    if (raw === undefined || raw === null || raw === '') {
      return null;
    }
    if (typeof raw !== 'string') {
      throw new BadRequestException('mediaAssetId must be a string or null.');
    }
    const media = await this.prisma.mediaAsset.findUnique({
      where: { id: raw },
      select: { isActive: true },
    });
    if (!media) {
      throw new BadRequestException('That media asset does not exist.');
    }
    if (!media.isActive) {
      throw new BadRequestException('That media asset is not active.');
    }
    return raw;
  }

  private async validatePromotionId(raw: unknown): Promise<string | null> {
    if (raw === undefined || raw === null || raw === '') {
      return null;
    }
    if (typeof raw !== 'string') {
      throw new BadRequestException('promotionId must be a string or null.');
    }
    const promotion = await this.prisma.promotion.findUnique({
      where: { id: raw },
      select: { id: true },
    });
    if (!promotion) {
      throw new BadRequestException('That promotion does not exist.');
    }
    return raw;
  }

  private async validateLoyaltyBonusPromotionId(
    raw: unknown,
  ): Promise<string | null> {
    if (raw === undefined || raw === null || raw === '') {
      return null;
    }
    if (typeof raw !== 'string') {
      throw new BadRequestException(
        'loyaltyBonusPromotionId must be a string or null.',
      );
    }
    const promotion = await this.prisma.loyaltyBonusPromotion.findUnique({
      where: { id: raw },
      select: { id: true },
    });
    if (!promotion) {
      throw new BadRequestException(
        'That bonus Mocha Bean promotion does not exist.',
      );
    }
    return raw;
  }

  private normalizeFeaturedProductIds(raw: unknown): string[] {
    if (raw === undefined || raw === null) {
      return [];
    }
    if (
      !Array.isArray(raw) ||
      raw.some((id) => typeof id !== 'string' || id.trim().length === 0)
    ) {
      throw new BadRequestException('Featured product ids must be non-empty strings.');
    }
    const ids = (raw as string[]).map((id) => id.trim());
    if (ids.length > CAMPAIGN_FEATURED_PRODUCTS_MAX) {
      throw new BadRequestException(
        `A campaign can feature at most ${CAMPAIGN_FEATURED_PRODUCTS_MAX} products.`,
      );
    }
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Featured products cannot contain duplicates.');
    }
    return ids;
  }

  private async assertProductsExistAndActive(productIds: string[]): Promise<void> {
    const found = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, isActive: true },
    });
    if (found.length !== productIds.length) {
      throw new BadRequestException('One or more featured products do not exist.');
    }
    if (found.some((p) => !p.isActive)) {
      throw new BadRequestException('One or more featured products are not active.');
    }
  }
}
