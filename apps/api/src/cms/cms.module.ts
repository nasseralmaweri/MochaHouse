import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AdminCmsController } from './api/admin-cms.controller';
import { CmsController } from './api/cms.controller';
import { CmsPagesAdminService } from './application/cms-pages-admin.service';
import { CmsContentPublicService } from './application/cms-content-public.service';

// Milestone 8E — CMS foundation. Structured content management for a
// small, code-defined set of public page keys (the registry) — NOT a page
// builder. HQ manages pages (Admin → Content, cms.view / cms.manage,
// CORPORATE-only); the public site reads PUBLISHED content only. The ONLY
// new table is CmsPage — no relation to any other domain model.
//
// InternalAuthGuard / PermissionGuard come from the @Global
// InternalAuthModule; PrismaService from the @Global PrismaModule;
// InternalAuditService from AuditModule.
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AdminCmsController, CmsController],
  providers: [CmsPagesAdminService, CmsContentPublicService],
})
export class CmsModule {}
