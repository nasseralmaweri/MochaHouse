import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OutboxProcessorService } from './outbox-processor.service';

@Module({
  imports: [PrismaModule, NotificationsModule],
  providers: [OutboxProcessorService],
})
export class OutboxModule {}
