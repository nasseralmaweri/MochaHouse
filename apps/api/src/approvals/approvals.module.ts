import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AdminApprovalsController } from './api/admin-approvals.controller';
import { ApprovalsAdminService } from './application/approvals-admin.service';

// Milestone 8J — Approvals: a generic request/decide primitive. This
// module owns ONLY the ApprovalRequest table and the decider-facing
// /admin/approvals screens. It never imports MarketingModule — the
// dependency runs the other way (Marketing calls the plain, ungated
// helpers in approval-requests.ts to create/read requests), keeping this
// module reusable by a future target type without circular imports.
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AdminApprovalsController],
  providers: [ApprovalsAdminService],
})
export class ApprovalsModule {}
