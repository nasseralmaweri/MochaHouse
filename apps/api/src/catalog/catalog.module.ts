import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AdminCatalogController } from './api/admin-catalog.controller';
import { CatalogController } from './api/catalog.controller';
import { CatalogService } from './application/catalog.service';
import { CatalogCreationService } from './application/catalog-creation.service';

// Milestone S0D-2A — TenancyModule is imported explicitly: the override
// writes require the request's TenantContext (established by its middleware).
@Module({
  imports: [PrismaModule, TenancyModule, AuditModule],
  controllers: [CatalogController, AdminCatalogController],
  providers: [CatalogService, CatalogCreationService],
})
export class CatalogModule {}