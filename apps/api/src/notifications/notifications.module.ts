import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AdminNotificationRecipientsController } from './api/admin-notification-recipients.controller';
import { NotificationRecipientConfigurationService } from './application/notification-recipient-configuration.service';

// Milestone S0D-2C-3 — tenant-owned notification recipient routing admin
// capability. InternalAuthGuard / PermissionGuard / AuthorizationService
// come from the @Global InternalAuthModule; PrismaService from the
// @Global PrismaModule; InternalAuditService from AuditModule (recipient
// create/update is audited in the same transaction).
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AdminNotificationRecipientsController],
  providers: [NotificationRecipientConfigurationService],
})
export class NotificationsModule {}
