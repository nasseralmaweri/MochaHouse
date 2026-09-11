import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  FranchisingPageContent,
  PublicCmsPageContentResponse,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { getRegistryEntry } from '../registry/cms-page-registry';

// Milestone 8E — the PUBLIC content read. No auth. Returns
// `publishedContent` ONLY — an unknown key, a key with no row, or a key
// that has never been published are all 404 alike (never revealing which).
// Draft content is never reachable from this service.
@Injectable()
export class CmsContentPublicService {
  constructor(private readonly prisma: PrismaService) {}

  async getPublished(rawKey: string): Promise<PublicCmsPageContentResponse> {
    const entry = getRegistryEntry(rawKey);
    if (!entry) {
      throw new NotFoundException('Content page not found.');
    }

    const row = await this.prisma.cmsPage.findUnique({
      where: { key: entry.key },
      select: { status: true, publishedContent: true },
    });
    if (!row || row.status !== 'PUBLISHED' || row.publishedContent === null) {
      throw new NotFoundException('Content page not found.');
    }

    return {
      content: row.publishedContent as unknown as FranchisingPageContent,
    };
  }
}
