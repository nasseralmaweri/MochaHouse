import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AdminCmsPageDetail,
  AdminCmsPageSummary,
  AdminCmsPagesResponse,
  CmsPageContent,
  CmsPageKey,
} from '@mocha-house/contracts';
import { CMS_PAGE_KEYS } from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import {
  CMS_PAGE_REGISTRY,
  getRegistryEntry,
  type CmsPageRegistryEntry,
} from '../registry/cms-page-registry';

type CmsPageRow = Prisma.CmsPageGetPayload<Record<string, never>>;

// HQ view + management of CMS pages (Milestone 8E). `cms.view` /
// `cms.manage` are CORPORATE-only. Every method also calls
// assertCorporate. GET never writes to the database — a missing row is
// synthesized from the registry default. The first PATCH (save draft) or
// POST .../publish is what actually creates the row.
@Injectable()
export class CmsPagesAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  async list(authorization: AuthorizationContext): Promise<AdminCmsPagesResponse> {
    authorization.assertCorporate('cms.view');

    const rows = await this.prisma.cmsPage.findMany({
      where: { key: { in: [...CMS_PAGE_KEYS] } },
    });
    const rowByKey = new Map(rows.map((row) => [row.key, row]));

    return {
      pages: CMS_PAGE_KEYS.map((key) =>
        this.toSummary(CMS_PAGE_REGISTRY[key], rowByKey.get(key) ?? null),
      ),
    };
  }

  async getDetail(
    rawKey: string,
    authorization: AuthorizationContext,
  ): Promise<AdminCmsPageDetail> {
    authorization.assertCorporate('cms.view');
    const entry = this.entryOrThrow(rawKey);

    const row = await this.prisma.cmsPage.findUnique({ where: { key: entry.key } });
    return this.toDetail(entry, row);
  }

  async saveDraft(
    rawKey: string,
    rawContent: unknown,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminCmsPageDetail> {
    authorization.assertCorporate('cms.manage');
    const entry = this.entryOrThrow(rawKey);
    const content = entry.validate(rawContent);
    if (entry.validateReferences) {
      await entry.validateReferences(content, this.prisma);
    }

    const existing = await this.prisma.cmsPage.findUnique({
      where: { key: entry.key },
    });
    const previousDraft = existing
      ? (existing.draftContent as unknown as CmsPageContent)
      : entry.defaultContent;
    const changedFieldKeys = entry.changedFieldKeys(previousDraft, content);

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.cmsPage.upsert({
        where: { key: entry.key },
        create: {
          key: entry.key,
          title: entry.title,
          draftContent: content as object,
        },
        update: {
          // draftContent only — status / publishedContent / publishedAt
          // are untouched by a draft save, even for an already-PUBLISHED
          // page.
          draftContent: content as object,
        },
      });
      await this.audit.recordCmsContentUpdated(tx, {
        actorInternalUserId,
        cmsPageId: row.id,
        pageKey: entry.key,
        changedFieldKeys,
      });
      return row;
    });

    return this.toDetail(entry, updated);
  }

  async publish(
    rawKey: string,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminCmsPageDetail> {
    authorization.assertCorporate('cms.manage');
    const entry = this.entryOrThrow(rawKey);

    const existing = await this.prisma.cmsPage.findUnique({
      where: { key: entry.key },
    });
    // Re-validate defensively — the stored draft was already validated on
    // save, but this guards against any out-of-band data (and catches a
    // reference that became invalid, e.g. a media asset deactivated, or a
    // product deactivated, since the draft was last saved).
    const draft = entry.validate(
      existing ? existing.draftContent : entry.defaultContent,
    );
    if (entry.validateReferences) {
      await entry.validateReferences(draft, this.prisma);
    }
    const publishedAt = new Date();

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.cmsPage.upsert({
        where: { key: entry.key },
        create: {
          key: entry.key,
          title: entry.title,
          draftContent: draft as object,
          publishedContent: draft as object,
          status: 'PUBLISHED',
          publishedAt,
        },
        update: {
          publishedContent: draft as object,
          status: 'PUBLISHED',
          publishedAt,
        },
      });
      await this.audit.recordCmsContentPublished(tx, {
        actorInternalUserId,
        cmsPageId: row.id,
        pageKey: entry.key,
        publishedAt,
      });
      return row;
    });

    return this.toDetail(entry, updated);
  }

  private entryOrThrow(rawKey: string): CmsPageRegistryEntry {
    const entry = getRegistryEntry(rawKey);
    if (!entry) {
      throw new NotFoundException('Content page not found.');
    }
    return entry;
  }

  private toSummary(
    entry: CmsPageRegistryEntry,
    row: CmsPageRow | null,
  ): AdminCmsPageSummary {
    if (!row) {
      return {
        key: entry.key,
        title: entry.title,
        status: 'DRAFT',
        publishedAt: null,
        updatedAt: null,
        hasUnpublishedChanges: true,
      };
    }
    return {
      key: entry.key,
      title: entry.title,
      status: row.status,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      hasUnpublishedChanges: this.hasUnpublishedChanges(row),
    };
  }

  private toDetail(
    entry: CmsPageRegistryEntry,
    row: CmsPageRow | null,
  ): AdminCmsPageDetail {
    if (!row) {
      return {
        key: entry.key,
        title: entry.title,
        status: 'DRAFT',
        draftContent: entry.defaultContent,
        publishedContent: null,
        publishedAt: null,
        updatedAt: null,
        hasUnpublishedChanges: true,
      };
    }
    return {
      key: entry.key,
      title: entry.title,
      status: row.status,
      draftContent: row.draftContent as unknown as CmsPageContent,
      publishedContent:
        (row.publishedContent as unknown as CmsPageContent | null) ?? null,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      hasUnpublishedChanges: this.hasUnpublishedChanges(row),
    };
  }

  private hasUnpublishedChanges(row: CmsPageRow): boolean {
    if (row.status !== 'PUBLISHED' || row.publishedContent === null) {
      return true;
    }
    return (
      JSON.stringify(row.draftContent) !== JSON.stringify(row.publishedContent)
    );
  }
}
