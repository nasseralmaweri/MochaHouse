import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { MediaStorageModule } from '../media/storage/media-storage.module';
import { AdminCmsController } from './api/admin-cms.controller';
import { CmsController } from './api/cms.controller';
import { CmsPagesAdminService } from './application/cms-pages-admin.service';
import { CmsContentPublicService } from './application/cms-content-public.service';
import { HomeContentPublicService } from './application/home-content-public.service';

// Milestone 8E/8F — CMS foundation. Structured content management for a
// small, code-defined set of public page keys (the registry) — NOT a page
// builder. HQ manages pages (Admin → Content, cms.view / cms.manage,
// CORPORATE-only); the public site reads PUBLISHED content only. The ONLY
// new table is CmsPage — no relation to any other domain model.
//
// MediaStorageModule is imported so HomeContentPublicService (8F) can
// resolve Home's hero backgroundImageId to a URL through the same
// MediaStorage abstraction the Media Library uses — one source of truth
// for public-URL resolution regardless of provider.
//
// InternalAuthGuard / PermissionGuard come from the @Global
// InternalAuthModule; PrismaService from the @Global PrismaModule;
// InternalAuditService from AuditModule.
@Module({
  imports: [PrismaModule, AuditModule, MediaStorageModule],
  controllers: [AdminCmsController, CmsController],
  providers: [
    CmsPagesAdminService,
    CmsContentPublicService,
    HomeContentPublicService,
  ],
})
export class CmsModule {}
