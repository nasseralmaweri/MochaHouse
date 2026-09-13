import { Injectable, Logger } from '@nestjs/common';
import type { EmailSender, SendEmailInput, SendEmailResult } from './email-sender';

// Milestone 8H — the dev/test EmailSender. Never makes a network call, so
// running tests, builds, or ordinary local development NEVER requires real
// AWS/SES credentials. Every send is logged and kept in memory so specs can
// assert on what would have gone out. This is the default provider unless
// NOTIFICATIONS_EMAIL_PROVIDER=ses is explicitly set.
@Injectable()
export class LoggingEmailSender implements EmailSender {
  private readonly logger = new Logger(LoggingEmailSender.name);
  private readonly sent: SendEmailInput[] = [];

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    this.sent.push(input);
    this.logger.log(`email (logged, not sent): to=${input.to} subject="${input.subject}"`);
    return { providerMessageId: `log-${this.sent.length}` };
  }

  // Test-only accessor — not part of the shared EmailSender interface, the
  // real SES provider has no equivalent.
  getSent(): readonly SendEmailInput[] {
    return this.sent;
  }

  clear(): void {
    this.sent.length = 0;
  }
}
