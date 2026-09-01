import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OpeningChecklistController } from './api/opening-checklist.controller';
import { OpeningChecklistService } from './application/opening-checklist.service';

// Store Operations (Milestone 6B) — the Opening Checklist workflow.
// InternalAuthGuard / PermissionGuard / AuthorizationService come from the
// @Global InternalAuthModule; PrismaService from the @Global PrismaModule.
@Module({
  imports: [PrismaModule],
  controllers: [OpeningChecklistController],
  providers: [OpeningChecklistService],
})
export class OperationsModule {}
