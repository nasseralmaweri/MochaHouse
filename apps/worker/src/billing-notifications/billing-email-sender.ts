import { Injectable, Logger } from '@nestjs/common';
import type {
  EmailSender,
  SendEmailInput,
  SendEmailResult,
} from '../notifications/email/email-sender';
import { SesEmailSender } from '../notifications/email/ses-email-sender';

// SC3c-3 — the CENTERIVO billing sender, SEPARATE from the restaurant
// notification sender: its own from-address (BILLING_EMAIL_FROM) and its
// own provider switch (BILLING_EMAIL_PROVIDER, "ses" | anything else = log).
// It reuses the SES client approach unchanged; the restaurant sender's
// configuration and behaviour are untouched.

export const BILLING_EMAIL_SENDER = Symbol('BILLING_EMAIL_SENDER');
export const BILLING_EMAIL_DISPLAY_NAME = 'CENTERIVO';

@Injectable()
export class BillingSesEmailSender extends SesEmailSender {
  protected override readonly fromAddressEnv = 'BILLING_EMAIL_FROM';
  protected override readonly providerEnv = 'BILLING_EMAIL_PROVIDER';
}

// Local / test: never sends; keeps what would have gone out in memory and
// logs only the subject (never the recipient's address).
@Injectable()
export class BillingLoggingEmailSender implements EmailSender {
  private readonly logger = new Logger(BillingLoggingEmailSender.name);
  private readonly sent: SendEmailInput[] = [];

  send(input: SendEmailInput): Promise<SendEmailResult> {
    this.sent.push(input);
    this.logger.log(
      `billing email (logged, not sent): subject="${input.subject}"`,
    );
    return Promise.resolve({
      providerMessageId: `billing-log-${this.sent.length}`,
    });
  }

  getSent(): readonly SendEmailInput[] {
    return this.sent;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

export function selectBillingEmailSender(
  log: BillingLoggingEmailSender,
  ses: BillingSesEmailSender,
  env: Record<string, string | undefined> = process.env,
): EmailSender {
  return env.BILLING_EMAIL_PROVIDER === 'ses' ? ses : log;
}
