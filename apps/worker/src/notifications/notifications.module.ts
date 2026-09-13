import { Module } from '@nestjs/common';
import { EmailSenderModule } from './email/email-sender.module';
import { NotificationDispatchService } from './notification-dispatch.service';

@Module({
  imports: [EmailSenderModule],
  providers: [NotificationDispatchService],
  exports: [NotificationDispatchService],
})
export class NotificationsModule {}
