import { Injectable } from '@nestjs/common';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import type { EmailSender, SendEmailInput, SendEmailResult } from './email-sender';

// Milestone 8H — the production EmailSender. Credentials are resolved
// through the normal AWS SDK provider chain (environment variables, a
// shared config/credentials file, or an IAM role) — this class never reads
// or stores a credential itself, mirroring apps/api's S3MediaStorage
// (Milestone 8F). Configuration is read lazily (not in the constructor) so
// this provider can be registered in every environment without requiring
// SES configuration to exist — it only throws if it is actually asked to
// send while NOTIFICATIONS_EMAIL_PROVIDER=ses is active without a
// from-address configured, which is what "fail clearly in production if
// SES configuration is incomplete" means here: the failure surfaces as a
// FAILED NotificationDelivery with this message, not a crashed worker
// (see NotificationDispatchService).
@Injectable()
export class SesEmailSender implements EmailSender {
  private client: SESClient | null = null;

  private getClient(): SESClient {
    if (!this.client) {
      this.client = new SESClient({
        region: process.env.NOTIFICATIONS_SES_REGION ?? process.env.AWS_REGION,
      });
    }
    return this.client;
  }

  private getFromAddress(): string {
    const from = process.env.NOTIFICATIONS_SES_FROM_EMAIL;
    if (!from) {
      throw new Error(
        'NOTIFICATIONS_SES_FROM_EMAIL is not set. Required when NOTIFICATIONS_EMAIL_PROVIDER=ses.',
      );
    }
    return from;
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const response = await this.getClient().send(
      new SendEmailCommand({
        Source: this.getFromAddress(),
        Destination: { ToAddresses: [input.to] },
        Message: {
          Subject: { Data: input.subject },
          Body: {
            Html: { Data: input.html },
            Text: { Data: input.text },
          },
        },
      }),
    );
    return { providerMessageId: response.MessageId };
  }
}
