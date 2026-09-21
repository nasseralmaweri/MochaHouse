import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminReportsController } from './admin-reports.controller';
import { OrdersOverviewReportService } from './orders-overview.service';
import { LocationPerformanceReportService } from './location-performance.service';

// HQ Reporting (Milestone 9A: Digital Sales & Orders; Milestone 9B:
// Location Performance). InternalAuthGuard / PermissionGuard /
// AuthorizationService come from the @Global InternalAuthModule;
// PrismaService from the @Global PrismaModule. Plain PostgreSQL/Prisma
// aggregate queries over the existing Order/Location tables — no reporting
// tables, no migration, no background job.
@Module({
  imports: [PrismaModule],
  controllers: [AdminReportsController],
  providers: [OrdersOverviewReportService, LocationPerformanceReportService],
})
export class ReportsModule {}
