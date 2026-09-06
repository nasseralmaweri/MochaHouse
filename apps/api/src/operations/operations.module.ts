import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { OpeningChecklistController } from './api/opening-checklist.controller';
import { ClosingChecklistController } from './api/closing-checklist.controller';
import { OpeningChecklistTemplateConfigController } from './api/opening-checklist-template-config.controller';
import { ClosingChecklistTemplateConfigController } from './api/closing-checklist-template-config.controller';
import { OperationsTasksController } from './api/operations-tasks.controller';
import { ChecklistExecutionService } from './application/checklist-execution.service';
import { ChecklistTemplateConfigService } from './application/checklist-template-config.service';
import { OperationsTasksService } from './application/operations-tasks.service';

// Store Operations — the daily checklists and Today's Tasks.
//   Milestone 6B   — Opening Checklist store execution (a location's daily
//                    instance).
//   Milestone 6B-2 — HQ configuration of the corporate checklist template.
//   Milestone 6C   — Today's Tasks and the checklist Management Exception
//                    (audited).
//   Milestone 6D   — Closing Checklist — the same execution + configuration
//                    services, parameterised by ChecklistTemplate.key.
//
// InternalAuthGuard / PermissionGuard / AuthorizationService come from the
// @Global InternalAuthModule; PrismaService from the @Global PrismaModule;
// InternalAuditService from AuditModule (exception events only).
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [
    OpeningChecklistController,
    ClosingChecklistController,
    OpeningChecklistTemplateConfigController,
    ClosingChecklistTemplateConfigController,
    OperationsTasksController,
  ],
  providers: [
    ChecklistExecutionService,
    ChecklistTemplateConfigService,
    OperationsTasksService,
  ],
})
export class OperationsModule {}
