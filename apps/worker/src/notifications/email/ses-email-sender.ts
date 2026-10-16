import { Injectable } from '@nestjs/common';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { headerText } from './header-text';
import type {
  EmailSender,
  SendEmailInput,
  SendEmailResult,
} from './email-sender';
import { EmailProviderRejection } from '../delivery-errors';

// R1 / S4b — SES answers synchronously: a 200 means the message was accepted for
// delivery. Any HTTP error response means it was not. These are the error names
// worth retrying (throttling, outages, account or domain problems an operator can
// fix); everything else with a response (MessageRejected, InvalidParameterValue,
// ...) will never succeed for this message.
const RETRYABLE_SES_ERRORS = new Set([
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
  'RequestLimitExceeded',
  'LimitExceededException',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'InternalFailure',
  'InternalServerError',
  'AccountSendingPausedException',
  'MailFromDomainNotVerifiedException',
  'CredentialsProviderError',
  // Credential / permission problems an operator can fix; dead-lettering the
  // queue because a key expired would lose notifications that could be sent.
  'AccessDenied',
  'AccessDeniedException',
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'SignatureDoesNotMatch',
]);

// Network failures that happen BEFORE a request can have been delivered (the
// connection was refused, the name did not resolve). Nothing was sent, so they
// are definite and safe to retry without the duplicate caveat. Resets and
// timeouts are NOT in this list: they can happen after SES received the request.
const PRE_REQUEST_NETWORK_ERRORS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function networkErrorCode(error: unknown): string | undefined {
  const direct = (error as { code?: unknown } | null)?.code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof cause === 'string' ? cause : undefined;
}

function isRetryableSesError(
  name: string,
  status: number | undefined,
): boolean {
  return (
    RETRYABLE_SES_ERRORS.has(name) ||
    status === 429 ||
    (status !== undefined && status >= 500)
  );
}

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

  // SC3c-3 — which variable holds the sender address. The restaurant
  // notification sender keeps NOTIFICATIONS_SES_FROM_EMAIL; the CENTERIVO
  // billing sender (BillingSesEmailSender) uses BILLING_EMAIL_FROM.
  protected readonly fromAddressEnv: string = 'NOTIFICATIONS_SES_FROM_EMAIL';
  protected readonly providerEnv: string = 'NOTIFICATIONS_EMAIL_PROVIDER';

  private getFromAddress(): string {
    const from = process.env[this.fromAddressEnv];
    if (!from) {
      throw new Error(
        `${this.fromAddressEnv} is not set. Required when ${this.providerEnv}=ses.`,
      );
    }
    return from;
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    // Missing configuration is refused before any request is made: definitely
    // not sent, and fixable by an operator (so retryable).
    let source: string;
    try {
      source = formatSource(this.getFromAddress(), input.fromName);
    } catch (error) {
      throw new EmailProviderRejection(
        'SES_NOT_CONFIGURED',
        error instanceof Error ? error.message : 'SES is not configured.',
        true,
      );
    }
    try {
      const response = await this.getClient().send(
        new SendEmailCommand({
          Source: source,
          Destination: { ToAddresses: [input.to] },
          Message: {
            Subject: { Data: input.subject },
            Body: {
              Html: { Data: input.html },
              Text: { Data: input.text },
            },
          },
        }),
        input.abortSignal ? { abortSignal: input.abortSignal } : undefined,
      );
      return { providerMessageId: response.MessageId };
    } catch (error) {
      // An error WITH an HTTP status means SES answered and refused the message.
      // No status (timeout, abort, connection loss) is left as-is: ambiguous.
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      const name = error instanceof Error ? error.name : 'Error';
      const netCode = networkErrorCode(error);
      if (netCode && PRE_REQUEST_NETWORK_ERRORS.has(netCode)) {
        throw new EmailProviderRejection(
          netCode,
          `Could not reach the email provider (${netCode}).`,
          true,
        );
      }
      // Only an HTTP ERROR status is a refusal. A 2xx with an exception (for
      // example a response we failed to parse) may well have been accepted:
      // ambiguous, so it is left as-is.
      if (
        (status !== undefined && status >= 400) ||
        name === 'CredentialsProviderError'
      ) {
        throw new EmailProviderRejection(
          name,
          error instanceof Error ? error.message : 'SES rejected the message.',
          isRetryableSesError(name, status),
        );
      }
      throw error;
    }
  }
}

// Security 4A — `"Business Name" <address>`. The display name is made
// header-safe (no control characters, so no header injection); ASCII names
// are sent as an RFC 5322 quoted string, anything else as an RFC 2047
// encoded word. An empty name falls back to the bare address.
export function formatSource(address: string, displayName?: string): string {
  const name = headerText(displayName ?? '');
  if (!name) {
    return address;
  }
  if (/^[\x20-\x7e]*$/.test(name)) {
    return `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>`;
  }
  return `=?UTF-8?B?${Buffer.from(name, 'utf8').toString('base64')}?= <${address}>`;
}
