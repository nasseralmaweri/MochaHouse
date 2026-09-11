import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { MediaStorageModule } from './storage/media-storage.module';
import { AdminMediaController } from './api/admin-media.controller';
import { MediaObjectsController } from './api/media-objects.controller';
import { MediaAssetsAdminService } from './application/media-assets-admin.service';

// Milestone 8F — the Media Library. HQ uploads/browses/deactivates images
// (Admin → Media, media.view / media.manage, CORPORATE-only) that CMS
// content (currently Home's hero) can reference by id. Storage is behind
// the MediaStorage abstraction (MediaStorageModule) — this module never
// talks to AWS or the filesystem directly.
//
// InternalAuthGuard / PermissionGuard come from the @Global
// InternalAuthModule; PrismaService from the @Global PrismaModule;
// InternalAuditService from AuditModule.
@Module({
  imports: [PrismaModule, AuditModule, MediaStorageModule],
  controllers: [AdminMediaController, MediaObjectsController],
  providers: [MediaAssetsAdminService],
})
export class MediaModule {}
