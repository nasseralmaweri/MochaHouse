// R1 / S4b — how a delivery attempt can fail, as typed errors, so the worker can
// tell "retry later" from "give up" from "we cannot know".

// The event can never be delivered as it stands (order or recipient missing,
// nothing configured for the business). Dead-lettered immediately.
export class PermanentNotificationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentNotificationError';
  }
}

// R1 / S5b — the message must deliberately NOT be sent, because what it
// announces is no longer true (a READY notice for an order that was rejected
// or cancelled). Not a failure: the event is completed without sending.
export class SuppressedNotification extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SuppressedNotification';
  }
}

// The email provider ANSWERED and refused the message, so nothing was sent.
// `retryable` separates throttling / outages (try again) from a rejection that
// will never succeed (invalid parameter, rejected message).
export class EmailProviderRejection extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmailProviderRejection';
  }
}

// A send that was abandoned because it outran its timeout. The provider may or
// may not have accepted the message.
export class SendTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The email provider did not answer within ${timeoutMs} ms.`);
    this.name = 'SendTimeoutError';
  }
}
