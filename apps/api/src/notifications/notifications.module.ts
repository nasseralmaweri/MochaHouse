import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AdminNotificationRecipientsController } from './api/admin-notification-recipients.controller';
import { AdminNotificationHealthController } from './api/admin-notification-health.controller';
import { NotificationHealthService } from './application/notification-health.service';
import { NotificationRecipientConfigurationService } from './application/notification-recipient-configuration.service';

// Milestone S0D-2C-3 — tenant-owned notification recipient routing admin
// capability. InternalAuthGuard / PermissionGuard / AuthorizationService
// come from the @Global InternalAuthModule; PrismaService from the
// @Global PrismaModule; InternalAuditService from AuditModule (recipient
// create/update is audited in the same transaction).
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [
    AdminNotificationRecipientsController,
    AdminNotificationHealthController,
  ],
  providers: [
    NotificationRecipientConfigurationService,
    NotificationHealthService,
  ],
})
export class NotificationsModule {}
