import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  HomePageContent,
  ProductSummary,
  PublicHomePageContentResponse,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MEDIA_STORAGE,
  type MediaStorage,
} from '../../media/storage/media-storage';

const CATEGORY_SELECT = {
  id: true,
  name: true,
  slug: true,
  displayOrder: true,
} as const;

const PRODUCT_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  basePrice: true,
  currency: true,
  category: { select: CATEGORY_SELECT },
} as const;

// Milestone 8F — the PUBLIC Home content read. No auth. Published content
// only, exactly like CmsContentPublicService, but Home's response is
// RESOLVED server-side: `hero.backgroundImageId` becomes a
// `backgroundImageUrl` (or null — a missing/deactivated image never
// breaks the page), and `featuredProducts.productIds` becomes the full
// authoritative `ProductSummary[]` (CMS ordering preserved; any
// missing/inactive product is silently dropped). The public page never
// needs a second fetch and never sees a bare id.
@Injectable()
export class HomeContentPublicService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
  ) {}

  async getPublished(): Promise<PublicHomePageContentResponse> {
    const row = await this.prisma.cmsPage.findUnique({
      where: { key: 'home' },
      select: { status: true, publishedContent: true },
    });
    if (!row || row.status !== 'PUBLISHED' || row.publishedContent === null) {
      throw new NotFoundException('Content page not found.');
    }

    const content = row.publishedContent as unknown as HomePageContent;

    const backgroundImageUrl = await this.resolveBackgroundImageUrl(
      content.hero.backgroundImageId,
    );
    const products = await this.resolveFeaturedProducts(
      content.featuredProducts.productIds,
    );

    return {
      content: {
        hero: {
          headline: content.hero.headline,
          supportingText: content.hero.supportingText,
          buttonLabel: content.hero.buttonLabel,
          backgroundImageUrl,
        },
        featuredProducts: {
          heading: content.featuredProducts.heading,
          products,
        },
        seo: content.seo,
      },
    };
  }

  private async resolveBackgroundImageUrl(
    mediaAssetId: string | null,
  ): Promise<string | null> {
    if (!mediaAssetId) {
      return null;
    }
    const asset = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaAssetId },
      select: { isActive: true, objectKey: true },
    });
    if (!asset || !asset.isActive) {
      // Fail soft — a stale/deactivated reference never breaks the page.
      return null;
    }
    return this.storage.resolvePublicUrl(asset.objectKey);
  }

  private async resolveFeaturedProducts(
    productIds: string[],
  ): Promise<ProductSummary[]> {
    if (productIds.length === 0) {
      return [];
    }
    const rows = await this.prisma.product.findMany({
      where: { id: { in: productIds }, isActive: true },
      select: PRODUCT_SELECT,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    // Preserve CMS ordering; silently drop any id that no longer resolves.
    return productIds
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
  }
}
