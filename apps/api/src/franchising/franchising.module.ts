import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { RedisModule } from '../redis/redis.module';
import { AdminFranchisingController } from './api/admin-franchising.controller';
import { FranchisingController } from './api/franchising.controller';
import { FranchiseInquiriesPublicService } from './application/franchise-inquiries-public.service';
import { FranchiseInquiriesAdminService } from './application/franchise-inquiries-admin.service';
import { FranchiseInquiryNotesService } from './application/franchise-inquiry-notes.service';
import { FranchisingPublicThrottleGuard } from './infrastructure/franchising-public-throttle.guard';

// Milestone 8D — Franchising inquiries. A visitor submits an inquiry from
// the public Franchising pages (no account); HQ views/manages inquiries
// (Admin → Franchising, franchising.view / franchising.manage,
// CORPORATE-only, single flat area — no sub-tabs). The ONLY new tables are
// FranchiseInquiry + FranchiseInquiryNote — no relation to any other
// domain model.
//
// InternalAuthGuard / PermissionGuard / AuthorizationService come from the
// @Global InternalAuthModule; PrismaService from the @Global PrismaModule;
// InternalAuditService from AuditModule; RedisService from the @Global
// RedisModule (used by the public throttle guard).
@Module({
  imports: [PrismaModule, AuditModule, RedisModule],
  controllers: [AdminFranchisingController, FranchisingController],
  providers: [
    FranchiseInquiriesPublicService,
    FranchiseInquiriesAdminService,
    FranchiseInquiryNotesService,
    FranchisingPublicThrottleGuard,
  ],
})
export class FranchisingModule {}
