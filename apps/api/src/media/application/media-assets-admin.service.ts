import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminMediaAsset,
  AdminMediaAssetsResponse,
} from '@mocha-house/contracts';
import {
  MEDIA_ALLOWED_CONTENT_TYPES,
  MEDIA_MAX_FILE_SIZE_BYTES,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { MEDIA_STORAGE, type MediaStorage } from '../storage/media-storage';
import { isMediaAssetReferenced } from './media-reference-check';

type MediaAssetRow = Prisma.MediaAssetGetPayload<{
  include: { uploadedByInternalUser: { select: { displayName: true; email: true } } };
}>;

const LIST_PAGE_SIZE = 25;

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Milestone 8F — HQ view + management of the media library. `media.view` /
// `media.manage` are CORPORATE-only; every method also calls
// assertCorporate. Deletion is soft (isActive) and refused (409) while the
// asset is referenced by known CMS content — see media-reference-check.
@Injectable()
export class MediaAssetsAdminService {
  private readonly logger = new Logger(MediaAssetsAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
  ) {}

  async list(
    query: { cursor?: string },
    authorization: AuthorizationContext,
  ): Promise<AdminMediaAssetsResponse> {
    authorization.assertCorporate('media.view');

    const where: Prisma.MediaAssetWhereInput = { isActive: true };
    if (typeof query.cursor === 'string' && query.cursor.length > 0) {
      // MediaAsset.id is a uuid7 — id-desc is monotonic with createdAt.
      where.id = { lt: query.cursor };
    }

    const rows = await this.prisma.mediaAsset.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_PAGE_SIZE + 1,
      include: {
        uploadedByInternalUser: { select: { displayName: true, email: true } },
      },
    });
    const hasMore = rows.length > LIST_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, LIST_PAGE_SIZE) : rows;

    return {
      assets: page.map((row) => this.toSummary(row)),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  async upload(
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number } | undefined,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminMediaAsset> {
    authorization.assertCorporate('media.manage');
    this.validateFile(file);
    const validFile = file!;

    const extension = EXTENSION_BY_CONTENT_TYPE[validFile.mimetype] ?? 'bin';
    // The object key is server-generated — the uploaded filename is never
    // trusted as (or used to derive) the storage key.
    const objectKey = `media/${randomUUID()}.${extension}`;
    const fileName = this.sanitizeFileName(validFile.originalname);

    await this.storage.put({
      objectKey,
      body: validFile.buffer,
      contentType: validFile.mimetype,
    });

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.mediaAsset.create({
          data: {
            objectKey,
            fileName,
            contentType: validFile.mimetype,
            fileSizeBytes: validFile.size,
            uploadedByInternalUserId: actorInternalUserId,
          },
          include: {
            uploadedByInternalUser: { select: { displayName: true, email: true } },
          },
        });
        await this.audit.recordMediaAssetUploaded(tx, {
          actorInternalUserId,
          mediaAssetId: created.id,
          fileName: created.fileName,
          contentType: created.contentType,
          fileSizeBytes: created.fileSizeBytes,
        });
        return created;
      });
      return this.toSummary(row);
    } catch (error) {
      // Storage succeeded but the DB write failed — best-effort cleanup so
      // we don't strand an orphaned object. Never let cleanup itself mask
      // the original error, and never overengineer a distributed
      // transaction here.
      this.logger.warn(
        `media DB write failed after storage.put succeeded; attempting best-effort cleanup of ${objectKey}`,
      );
      await this.storage.remove(objectKey).catch(() => undefined);
      throw error;
    }
  }

  async deactivate(
    mediaAssetId: string,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminMediaAsset> {
    authorization.assertCorporate('media.manage');
    const existing = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaAssetId },
      include: {
        uploadedByInternalUser: { select: { displayName: true, email: true } },
      },
    });
    if (!existing) {
      throw new NotFoundException('Media asset not found.');
    }
    if (!existing.isActive) {
      // Idempotent no-op — already deactivated, nothing to re-check or
      // re-audit.
      return this.toSummary(existing);
    }

    const referenced = await isMediaAssetReferenced(this.prisma, mediaAssetId);
    if (referenced) {
      throw new ConflictException(
        'This image is currently used as the Home page hero background and cannot be removed. Replace it there first.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.mediaAsset.update({
        where: { id: mediaAssetId },
        data: { isActive: false },
        include: {
          uploadedByInternalUser: { select: { displayName: true, email: true } },
        },
      });
      await this.audit.recordMediaAssetDeactivated(tx, {
        actorInternalUserId,
        mediaAssetId,
      });
      return row;
    });

    return this.toSummary(updated);
  }

  private validateFile(
    file: { buffer: Buffer; mimetype: string; size: number } | undefined,
  ): void {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('An image file is required.');
    }
    if (!(MEDIA_ALLOWED_CONTENT_TYPES as readonly string[]).includes(file.mimetype)) {
      throw new BadRequestException('Only JPEG, PNG, and WebP images are supported.');
    }
    if (file.size > MEDIA_MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `Images must be ${Math.floor(MEDIA_MAX_FILE_SIZE_BYTES / (1024 * 1024))} MB or smaller.`,
      );
    }
  }

  private sanitizeFileName(raw: string): string {
    const base = (raw || '').split(/[\\/]/).pop() ?? '';
    const cleaned = base.replace(/[^\w.\- ]/g, '').trim();
    return (cleaned.length > 0 ? cleaned : 'upload').slice(0, 200);
  }

  private toSummary(row: MediaAssetRow): AdminMediaAsset {
    return {
      id: row.id,
      fileName: row.fileName,
      contentType: row.contentType,
      fileSizeBytes: row.fileSizeBytes,
      publicUrl: this.storage.resolvePublicUrl(row.objectKey),
      uploadedByLabel: row.uploadedByInternalUser
        ? row.uploadedByInternalUser.displayName ?? row.uploadedByInternalUser.email
        : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
