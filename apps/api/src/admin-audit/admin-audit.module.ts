import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminAuditController } from './admin-audit.controller';
import { AdminAuditReadService } from './admin-audit.read-service';

// The Admin Activity Log (Milestone 5F): a read-only, business-facing view
// of the existing InternalAuditEvent history. Deliberately separate from
// AuditModule — that module owns the write side (InternalAuditService) and
// stays untouched. This module only reads the same table.
// InternalAuthGuard / PermissionGuard / AuthorizationService come from the
// @Global InternalAuthModule; PrismaService from the @Global PrismaModule.
@Module({
  imports: [PrismaModule],
  controllers: [AdminAuditController],
  providers: [AdminAuditReadService],
})
export class AdminAuditModule {}
