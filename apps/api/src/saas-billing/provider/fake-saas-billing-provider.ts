import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  BillingEventVerificationError,
  type ProviderLifecycleEvent,
  type SaasBillingProvider,
  type VerifiedBillingProviderEvent,
} from './saas-billing-provider';

// SC3a — a deterministic, in-memory SaaS billing provider for development
// and tests ONLY (refused in production-like environments; see
// saas-billing-provider-mode.ts). It moves no money and calls nothing.
//
// Events are signed like a real provider's webhooks so the verification
// path is exercised end to end:
//   header  "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}`>"
//   body    {"id","type","created","livemode","data":{...}}
// Operations are idempotent by key: repeating a key returns the first
// result, never a second object.

export const FAKE_SIGNATURE_TOLERANCE_SECONDS = 300;

export type FakeEventType =
  | 'payment_method.authorized'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'subscription.trial_ended'
  | 'subscription.cancel_scheduled'
  | 'subscription.cancel_undone'
  | 'subscription.ended';

export interface FakeEventBody {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: {
    subscription?: string | null;
    customer?: string | null;
    // Metadata — never trusted, only cross-checked.
    tenantId?: string | null;
    reference?: string | null;
    amount?: number | null;
    currency?: string | null;
    periodStart?: number | null;
    periodEnd?: number | null;
  };
}

function sign(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

function parseHeader(
  header: string | undefined,
): { timestamp: number; signatures: string[] } | null {
  if (typeof header !== 'string' || header.length > 1000) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't' && value && /^\d{1,12}$/.test(value)) {
      timestamp = Number(value);
    } else if (key === 'v1' && value && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(value);
    }
  }
  return timestamp === null || signatures.length === 0
    ? null
    : { timestamp, signatures };
}

// 2000-01-01 .. 9999: anything else is not a real time.
function toDate(seconds: unknown): Date | null {
  return typeof seconds === 'number' &&
    Number.isInteger(seconds) &&
    seconds >= 946_684_800 &&
    seconds <= 253_402_300_799
    ? new Date(seconds * 1000)
    : null;
}

function optionalText(value: unknown, max = 255): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : null;
}

export class FakeSaasBillingProvider implements SaasBillingProvider {
  readonly name = 'fake';
  readonly livemode = false;
  readonly available = true;
  private readonly customers = new Map<string, string>();
  private readonly subscriptions = new Map<string, string>();
  readonly calls: Array<{ op: string; idempotencyKey: string }> = [];

  constructor(
    private readonly webhookSecret: string = randomBytes(32).toString('hex'),
  ) {
    if (webhookSecret.length < 32) {
      throw new Error('The fake billing webhook secret is too short.');
    }
  }

  createCustomer(input: {
    idempotencyKey: string;
  }): Promise<{ externalCustomerId: string }> {
    this.calls.push({
      op: 'createCustomer',
      idempotencyKey: input.idempotencyKey,
    });
    const existing = this.customers.get(input.idempotencyKey);
    const id = existing ?? `fake_cus_${randomBytes(8).toString('hex')}`;
    this.customers.set(input.idempotencyKey, id);
    return Promise.resolve({ externalCustomerId: id });
  }

  createSubscription(input: {
    idempotencyKey: string;
  }): Promise<{ externalSubscriptionId: string }> {
    this.calls.push({
      op: 'createSubscription',
      idempotencyKey: input.idempotencyKey,
    });
    const existing = this.subscriptions.get(input.idempotencyKey);
    const id = existing ?? `fake_sub_${randomBytes(8).toString('hex')}`;
    this.subscriptions.set(input.idempotencyKey, id);
    return Promise.resolve({ externalSubscriptionId: id });
  }

  scheduleCancellation(input: { idempotencyKey: string }): Promise<void> {
    this.calls.push({
      op: 'scheduleCancellation',
      idempotencyKey: input.idempotencyKey,
    });
    return Promise.resolve();
  }

  undoCancellation(input: { idempotencyKey: string }): Promise<void> {
    this.calls.push({
      op: 'undoCancellation',
      idempotencyKey: input.idempotencyKey,
    });
    return Promise.resolve();
  }

  // Test helper: the signed delivery a real provider would send.
  signEvent(
    body: FakeEventBody,
    at: Date = new Date(),
  ): { rawBody: string; signatureHeader: string } {
    const rawBody = JSON.stringify(body);
    const timestamp = Math.floor(at.getTime() / 1000);
    return {
      rawBody,
      signatureHeader: `t=${timestamp},v1=${sign(this.webhookSecret, timestamp, rawBody)}`,
    };
  }

  verifyEvent(input: {
    rawBody: string;
    signatureHeader: string | undefined;
    now?: Date;
  }): VerifiedBillingProviderEvent {
    const { rawBody } = input;
    if (
      typeof rawBody !== 'string' ||
      rawBody.length === 0 ||
      rawBody.length > 65_536
    ) {
      throw new BillingEventVerificationError('Unreadable event.');
    }
    const header = parseHeader(input.signatureHeader);
    if (!header) throw new BillingEventVerificationError('Missing signature.');
    const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
    if (
      Math.abs(nowSeconds - header.timestamp) > FAKE_SIGNATURE_TOLERANCE_SECONDS
    ) {
      throw new BillingEventVerificationError(
        'Signature timestamp out of tolerance.',
      );
    }
    const expected = Buffer.from(
      sign(this.webhookSecret, header.timestamp, rawBody),
      'hex',
    );
    const valid = header.signatures.some((candidate) => {
      const given = Buffer.from(candidate, 'hex');
      return (
        given.length === expected.length && timingSafeEqual(given, expected)
      );
    });
    if (!valid) throw new BillingEventVerificationError('Invalid signature.');

    let body: FakeEventBody;
    try {
      body = JSON.parse(rawBody) as FakeEventBody;
    } catch {
      throw new BillingEventVerificationError('Unreadable event.');
    }
    const id = optionalText(body?.id);
    const type = optionalText(body?.type, 100);
    const occurredAt = toDate(body?.created);
    if (!id || !type || !occurredAt || typeof body.livemode !== 'boolean') {
      throw new BillingEventVerificationError('Incomplete event.');
    }
    // An event cannot have happened after it was signed.
    if (
      occurredAt.getTime() >
      (header.timestamp + FAKE_SIGNATURE_TOLERANCE_SECONDS) * 1000
    ) {
      throw new BillingEventVerificationError('Event time is in the future.');
    }
    const data =
      typeof body.data === 'object' && body.data !== null ? body.data : {};
    return {
      provider: this.name,
      externalEventId: id,
      providerType: type,
      livemode: body.livemode,
      occurredAt,
      payloadDigest: createHash('sha256').update(rawBody).digest('hex'),
      externalSubscriptionId: optionalText(data.subscription),
      externalCustomerId: optionalText(data.customer),
      claimedTenantId: optionalText(data.tenantId),
      event: this.normalize(type, data),
    };
  }

  private normalize(
    type: string,
    data: FakeEventBody['data'],
  ): ProviderLifecycleEvent {
    const reference = optionalText(data.reference);
    switch (type as FakeEventType) {
      case 'payment_method.authorized':
        return { kind: 'PAYMENT_AUTHORIZED' };
      case 'invoice.paid': {
        const amount = data.amount;
        const currency = optionalText(data.currency, 3);
        return reference &&
          currency &&
          typeof amount === 'number' &&
          Number.isInteger(amount) &&
          amount >= 0
          ? {
              kind: 'PAYMENT_SUCCEEDED',
              reference,
              amountMinorUnits: amount,
              currency: currency.toUpperCase(),
              periodStart: toDate(data.periodStart),
              periodEnd: toDate(data.periodEnd),
            }
          : { kind: 'UNSUPPORTED' };
      }
      case 'invoice.payment_failed':
        return reference
          ? { kind: 'PAYMENT_FAILED', reference }
          : { kind: 'UNSUPPORTED' };
      case 'subscription.trial_ended':
        return { kind: 'TRIAL_ENDED' };
      case 'subscription.cancel_scheduled':
        return { kind: 'CANCEL_SCHEDULED' };
      case 'subscription.cancel_undone':
        return { kind: 'CANCEL_UNDONE' };
      case 'subscription.ended':
        return { kind: 'SUBSCRIPTION_ENDED' };
      default:
        return { kind: 'UNSUPPORTED' };
    }
  }
}
