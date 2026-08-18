import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminCatalogController } from './api/admin-catalog.controller';
import { CatalogController } from './api/catalog.controller';
import { CatalogService } from './application/catalog.service';

@Module({
  imports: [PrismaModule],
  controllers: [CatalogController, AdminCatalogController],
  providers: [CatalogService],
})
export class CatalogModule {}