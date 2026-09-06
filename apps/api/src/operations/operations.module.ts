import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { OpeningChecklistController } from './api/opening-checklist.controller';
import { ChecklistTemplateConfigController } from './api/checklist-template-config.controller';
import { OperationsTasksController } from './api/operations-tasks.controller';
import { OpeningChecklistService } from './application/opening-checklist.service';
import { ChecklistTemplateConfigService } from './application/checklist-template-config.service';
import { OperationsTasksService } from './application/operations-tasks.service';

// Store Operations — the Opening Checklist and Today's Tasks.
//   Milestone 6B   — Opening Checklist store execution (a location's daily
//                    instance).
//   Milestone 6B-2 — HQ configuration of the one corporate template.
//   Milestone 6C   — Today's Tasks (simple per-day, per-location to-dos)
//                    and the checklist Management Exception (audited).
//
// InternalAuthGuard / PermissionGuard / AuthorizationService come from the
// @Global InternalAuthModule; PrismaService from the @Global PrismaModule;
// InternalAuditService from AuditModule (exception events only).
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [
    OpeningChecklistController,
    ChecklistTemplateConfigController,
    OperationsTasksController,
  ],
  providers: [
    OpeningChecklistService,
    ChecklistTemplateConfigService,
    OperationsTasksService,
  ],
})
export class OperationsModule {}
