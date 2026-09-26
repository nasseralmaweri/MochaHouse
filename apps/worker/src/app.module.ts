import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { OutboxModule } from './outbox/outbox.module';
import { WorkerTenancyModule } from './tenancy/worker-tenancy.module';

@Module({
  // Milestone S0C — WorkerTenancyModule validates SINGLE_TENANT_ID at
  // startup and provides the worker's TenantContext factory.
  imports: [PrismaModule, WorkerTenancyModule, OutboxModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
