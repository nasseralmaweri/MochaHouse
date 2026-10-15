import { Module } from '@nestjs/common';
import { OutboxConfigModule } from '../outbox/outbox-config.module';
import { EmailSenderModule } from './email/email-sender.module';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationRecipientResolver } from './notification-recipient-resolver.service';

@Module({
  imports: [EmailSenderModule, OutboxConfigModule],
  providers: [NotificationDispatchService, NotificationRecipientResolver],
  exports: [NotificationDispatchService],
})
export class NotificationsModule {}
