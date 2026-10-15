// Milestone 8H — a small, bounded email abstraction so no notification
// dispatch code ever calls an AWS SDK directly. Mirrors the shape of
// apps/api's MediaStorage abstraction (Milestone 8F): one interface, a
// production implementation and a local/test implementation, selected by
// EmailSenderModule from one env var.
export interface SendEmailInput {
  to: string;
  // Security 4A — the sending business's display name (Tenant.name). The
  // address stays the deployment's configured sender; only the name shown
  // to the recipient is per business. Omitted -> the bare address.
  fromName?: string;
  subject: string;
  html: string;
  text: string;
  // R1 / S4b — aborted by the caller when the attempt outruns its timeout. An
  // aborted send is an AMBIGUOUS outcome: the provider may have accepted it.
  abortSignal?: AbortSignal;
}

export interface SendEmailResult {
  providerMessageId?: string;
}

// Contract for failures (R1 / S4b): throw EmailProviderRejection when the
// provider ANSWERED and did not accept the message (or when the send was refused
// before any request left the process) — that is a DEFINITE failure and nothing
// was sent. Any other thrown error (timeout, connection loss, an unrecognised
// failure) is treated by the worker as AMBIGUOUS. A resolved promise means the
// provider ACCEPTED the message; it does not mean the recipient received it.
export interface EmailSender {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
