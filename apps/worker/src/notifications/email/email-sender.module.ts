import { Module } from '@nestjs/common';
import { EMAIL_SENDER } from './email-sender';
import { LoggingEmailSender } from './logging-email-sender';
import { SesEmailSender } from './ses-email-sender';

// Milestone 8H — selects the active EmailSender implementation from
// NOTIFICATIONS_EMAIL_PROVIDER ("ses" | anything else, default log). Both
// providers are always registered (SesEmailSender reads its AWS
// configuration lazily, never in its constructor) so the module boots fine
// in every environment — no AWS credentials required for tests, local
// development, or builds; only the selected one is ever exercised. Mirrors
// apps/api's MediaStorageModule (Milestone 8F).
@Module({
  providers: [
    LoggingEmailSender,
    SesEmailSender,
    {
      provide: EMAIL_SENDER,
      useFactory: (log: LoggingEmailSender, ses: SesEmailSender) =>
        process.env.NOTIFICATIONS_EMAIL_PROVIDER === 'ses' ? ses : log,
      inject: [LoggingEmailSender, SesEmailSender],
    },
  ],
  exports: [EMAIL_SENDER, LoggingEmailSender],
})
export class EmailSenderModule {}
