import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import {
  BILLING_EMAIL_SENDER,
  BillingLoggingEmailSender,
  BillingSesEmailSender,
  selectBillingEmailSender,
} from './billing-email-sender';
import { BillingNotificationProcessor } from './billing-notification-processor.service';
import { BillingNotificationStore } from './billing-notification-store';

// SC3c-3 — CENTERIVO billing notices: separate from the restaurant
// notification pipeline (its own queue, sender and from-address). Idle
// unless BILLING_NOTIFICATIONS_ENABLED=1.
@Module({
  imports: [PrismaModule],
  providers: [
    BillingLoggingEmailSender,
    BillingSesEmailSender,
    {
      provide: BILLING_EMAIL_SENDER,
      useFactory: selectBillingEmailSender,
      inject: [BillingLoggingEmailSender, BillingSesEmailSender],
    },
    BillingNotificationStore,
    BillingNotificationProcessor,
  ],
  exports: [BillingNotificationProcessor, BillingLoggingEmailSender],
})
export class BillingNotificationsModule {}
