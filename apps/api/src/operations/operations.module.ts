import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OpeningChecklistController } from './api/opening-checklist.controller';
import { ChecklistTemplateConfigController } from './api/checklist-template-config.controller';
import { OpeningChecklistService } from './application/opening-checklist.service';
import { ChecklistTemplateConfigService } from './application/checklist-template-config.service';

// Store Operations — the Opening Checklist. Milestone 6B: the store
// execution workflow (a location's daily instance). Milestone 6B-2: HQ
// configuration of the one corporate template the instances are built
// from. InternalAuthGuard / PermissionGuard / AuthorizationService come
// from the @Global InternalAuthModule; PrismaService from the @Global
// PrismaModule.
@Module({
  imports: [PrismaModule],
  controllers: [OpeningChecklistController, ChecklistTemplateConfigController],
  providers: [OpeningChecklistService, ChecklistTemplateConfigService],
})
export class OperationsModule {}
