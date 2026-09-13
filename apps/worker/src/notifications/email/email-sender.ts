// Milestone 8H — a small, bounded email abstraction so no notification
// dispatch code ever calls an AWS SDK directly. Mirrors the shape of
// apps/api's MediaStorage abstraction (Milestone 8F): one interface, a
// production implementation and a local/test implementation, selected by
// EmailSenderModule from one env var.
export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendEmailResult {
  providerMessageId?: string;
}

export interface EmailSender {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
