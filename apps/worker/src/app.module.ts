import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { OutboxModule } from './outbox/outbox.module';
import { WorkerTenancyModule } from './tenancy/worker-tenancy.module';
import { BillingNotificationsModule } from './billing-notifications/billing-notifications.module';

@Module({
  // Milestone S0C — WorkerTenancyModule validates SINGLE_TENANT_ID at
  // startup and provides the worker's TenantContext factory.
  imports: [
    PrismaModule,
    WorkerTenancyModule,
    OutboxModule,
    // SC3c-3 — CENTERIVO billing notices (off unless enabled).
    BillingNotificationsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
