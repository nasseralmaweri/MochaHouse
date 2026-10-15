import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OutboxConfigModule } from './outbox-config.module';
import { OutboxProcessorService } from './outbox-processor.service';
import { OutboxStore } from './outbox-store';

@Module({
  imports: [PrismaModule, NotificationsModule, OutboxConfigModule],
  providers: [OutboxStore, OutboxProcessorService],
})
export class OutboxModule {}
